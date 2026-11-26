//! From the end of a Song to its results (#175), over real HTTP and
//! WebSocket: the Stage sends the round's outcome (`POST /api/rounds`), the
//! server stores it once, decides places, Rank title bands and the "new
//! high score" flags, answers the Stage with the results and shows them to
//! the whole Party, each Phone finding its own Player's result.

use openstar::scores::{places, rank_title_band, rounds};
use openstar_protocol::library::{SongDetail, SongId, SongList, SongSummary};
use openstar_protocol::mics::MicKey;
use openstar_protocol::profile::{Avatar, AvatarKey, Difficulty, NewProfile, PaletteKey, Profile};
use openstar_protocol::scoring::{
    BeatRange, BeatValue, MicKind, PlayerResult, PlayerScore, RoundEnd, RoundMode, RoundOutcome,
    RoundStored, ScorePlayer, StoredRound,
};
use openstar_protocol::{
    Actor, ChangeEvent, ClientMessage, JoinAs, JoinCode, PartyEvent, PartyMemberId, PartySnapshot,
    PhoneId, RequestChange, RequestId, ServerMessage, SongControl, SongEnd, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};
use reqwest::StatusCode;

fn star() -> Avatar {
    Avatar::BuiltIn {
        key: AvatarKey::Star,
    }
}

/// A one-Voice Song of one Note: Beats 0 to 3.
fn write_song(app: &TestApp, title: &str) {
    let folder = app.songs_dir().join(title);
    std::fs::create_dir_all(&folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:Placeholder\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n"),
    )
    .unwrap();
}

async fn app_with_song() -> (TestApp, SongDetail) {
    let mut app = TestApp::start().await;
    write_song(&app, "Solo");
    app.restart().await;
    let songs: Vec<SongSummary> = app.get_json::<SongList>("/api/songs").await.songs;
    let id = songs.iter().find(|song| song.title == "Solo").unwrap().id;
    let detail = app.get_json(&format!("/api/songs/{}", id.0)).await;
    (app, detail)
}

/// The next message on `socket`, past change notices for HTTP data.
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. } => {}
            message => return message,
        }
    }
}

async fn party_changed(socket: &mut WsClient) -> (PartySnapshot, ChangeEvent) {
    match recv(socket).await {
        ServerMessage::PartyChanged { party, change } => (party, change),
        other => panic!("expected a Party change, got {other:?}"),
    }
}

async fn all_hear(sockets: &mut [&mut WsClient]) -> (PartySnapshot, ChangeEvent) {
    let mut heard = Vec::new();
    for socket in sockets.iter_mut() {
        heard.push(party_changed(socket).await);
    }
    for other in &heard[1..] {
        assert_eq!(other, &heard[0]);
    }
    heard.swap_remove(0)
}

async fn live_party(socket: &mut WsClient) -> Option<PartySnapshot> {
    match recv(socket).await {
        ServerMessage::LiveState { party, .. } => party,
        other => panic!("expected the live state first, got {other:?}"),
    }
}

async fn create_profile(app: &TestApp, name: &str, favourite: PaletteKey) -> Profile {
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(&NewProfile {
            name: name.to_owned(),
            avatar: star(),
            favourite_colour: favourite,
        })
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    response.json().await.unwrap()
}

fn phone_id(n: u32) -> PhoneId {
    PhoneId(format!("4b1d8f0e-0000-4000-8000-{n:012}"))
}

/// A Party on the Stage with one joined Phone per entry of `who`
/// (`Ok(profile)` or `Err(guest name)`), all requested for the Song, whose
/// Line-up seats each on their own Phone.
struct Room {
    stage: WsClient,
    phones: Vec<WsClient>,
    members: Vec<PartyMemberId>,
    party: PartySnapshot,
    request: RequestId,
}

impl Room {
    fn sockets(&mut self) -> Vec<&mut WsClient> {
        let mut sockets = vec![&mut self.stage];
        sockets.extend(self.phones.iter_mut());
        sockets
    }

    async fn hear(&mut self) -> (PartySnapshot, ChangeEvent) {
        let heard = all_hear(&mut self.sockets()).await;
        self.party = heard.0.clone();
        heard
    }

    async fn start(&mut self) {
        self.stage
            .send(&ClientMessage::ControlSong {
                request_id: self.request,
                control: SongControl::Start,
            })
            .await;
        self.hear().await;
        match recv(&mut self.stage).await {
            ServerMessage::ControlSong { control, .. } => assert_eq!(control, SongControl::Start),
            other => panic!("expected Start for the Stage, got {other:?}"),
        }
    }

    async fn control(&mut self, control: SongControl) {
        self.stage
            .send(&ClientMessage::ControlSong {
                request_id: self.request,
                control,
            })
            .await;
        self.hear().await;
        match recv(&mut self.stage).await {
            ServerMessage::ControlSong { control: told, .. } => assert_eq!(told, control),
            other => panic!("expected {control:?} for the Stage, got {other:?}"),
        }
    }
}

async fn room(app: &TestApp, song: &SongDetail, who: &[Result<&Profile, &str>]) -> Room {
    let mut stage = app.connect_stage().await;
    live_party(&mut stage).await;
    let (party, _) = party_changed(&mut stage).await;
    let code: JoinCode = party.join_code.clone();
    let mut phones: Vec<WsClient> = Vec::new();
    let mut members = Vec::new();
    for (n, who) in who.iter().enumerate() {
        let mut socket = app.connect_ws().await;
        live_party(&mut socket).await;
        let join_as = match who {
            Ok(profile) => JoinAs::Profile {
                profile_id: profile.id,
            },
            Err(name) => JoinAs::Guest(openstar_protocol::NewGuest {
                name: (*name).to_owned(),
                colour: PaletteKey::Grape,
                avatar: star(),
            }),
        };
        socket
            .send(&ClientMessage::Join {
                phone_id: phone_id(u32::try_from(n).unwrap() + 1),
                join_code: code.clone(),
                join_as,
            })
            .await;
        match recv(&mut socket).await {
            ServerMessage::PhoneStatus {
                member_id: Some(member_id),
            } => members.push(member_id),
            other => panic!("expected the Phone's status, got {other:?}"),
        }
        party_changed(&mut socket).await;
        party_changed(&mut stage).await;
        for other in &mut phones {
            party_changed(other).await;
        }
        phones.push(socket);
    }
    // The first Phone asks for everyone (the Stage names no Players).
    phones[0]
        .send(&ClientMessage::AddRequest {
            song_id: song.id,
            requested_players: Some(members.clone()),
        })
        .await;
    let mut room = Room {
        stage,
        phones,
        members,
        party,
        request: RequestId(0),
    };
    let (party, _) = room.hear().await;
    let line_up = party.line_up.clone().unwrap();
    assert!(line_up.can_start, "{line_up:?}");
    assert_eq!(line_up.seats.len(), who.len());
    room.request = line_up.request_id;
    room
}

/// A Score of `total` (Notes and Line bonus), Finished, on the whole Voice.
fn score(player: ScorePlayer, total: u32) -> PlayerScore {
    PlayerScore {
        player,
        voice: 0,
        difficulty: Difficulty::Medium,
        total,
        notes: total / 2,
        golden: 0,
        line_bonus: total - total / 2,
        mic_kind: MicKind::Phone,
        unfinished: false,
        mic_lost: false,
        beat_range: BeatRange {
            first_beat: 0,
            last_beat: 3,
        },
        beat_values: vec![BeatValue::Pitch { pitch: 60.0 }; 4],
    }
}

fn of(profile: &Profile) -> ScorePlayer {
    ScorePlayer::Profile {
        profile_id: profile.id,
    }
}

fn guest(name: &str) -> ScorePlayer {
    ScorePlayer::Guest { name: name.into() }
}

fn outcome(
    song: &SongDetail,
    room: &Room,
    ended: RoundEnd,
    scores: Vec<PlayerScore>,
) -> RoundOutcome {
    RoundOutcome {
        song_id: song.id,
        request_id: room.request,
        note_fingerprint: song.note_fingerprint.clone(),
        party_id: room.party.party_id.clone(),
        mode: RoundMode::Normal,
        started_at_ms: 1_700_000_000_000,
        ended,
        scores,
    }
}

async fn post(app: &TestApp, body: &RoundOutcome) -> (StatusCode, serde_json::Value) {
    let response = app
        .http()
        .post(app.url("/api/rounds"))
        .json(body)
        .send()
        .await
        .unwrap();
    (response.status(), response.json().await.unwrap())
}

async fn store(app: &TestApp, body: &RoundOutcome) -> RoundStored {
    let (status, json) = post(app, body).await;
    assert_eq!(status, StatusCode::CREATED, "{json}");
    serde_json::from_value(json).unwrap()
}

fn stored_rounds(app: &TestApp) -> Vec<StoredRound> {
    let conn =
        rusqlite::Connection::open(app.appdata_dir().join(openstar::db::DATABASE_FILE)).unwrap();
    conn.execute_batch("PRAGMA busy_timeout = 5000;").unwrap();
    rounds(&conn).unwrap()
}

fn summary(results: &[PlayerResult]) -> Vec<(String, u32, u32, u8)> {
    results
        .iter()
        .map(|r| (r.name.clone(), r.total, r.place, r.rank_title_band))
        .collect()
}

#[tokio::test]
async fn places_share_equal_totals_and_skip_the_next_place() {
    assert_eq!(places(&[]), Vec::<u32>::new());
    assert_eq!(places(&[5000, 5000, 100]), vec![1, 1, 3]);
    assert_eq!(places(&[100, 5000, 5000]), vec![3, 1, 1]);
    assert_eq!(places(&[0, 0, 0, 0]), vec![1, 1, 1, 1]);
    assert_eq!(places(&[10, 20, 20, 30]), vec![4, 2, 2, 1]);
}

#[tokio::test]
async fn the_rank_title_band_is_one_per_1250_points_and_at_most_7() {
    for (total, band) in [
        (0, 0),
        (1249, 0),
        (1250, 1),
        (8749, 6),
        (8750, 7),
        (10000, 7),
    ] {
        assert_eq!(rank_title_band(total), band, "at {total}");
    }
}

#[tokio::test]
async fn a_played_song_stores_its_round_and_shows_every_players_result_to_the_party() {
    let (app, song) = app_with_song().await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let mut room = room(&app, &song, &[Ok(&bo), Err("Cy")]).await;
    room.start().await;
    let seats = room.party.line_up.clone().unwrap().seats;

    let mut cy = score(guest("Cy"), 0);
    cy.unfinished = true;
    cy.mic_lost = true;
    let stored = store(
        &app,
        &outcome(
            &song,
            &room,
            RoundEnd::Played,
            vec![score(of(&bo), 5000), cy],
        ),
    )
    .await;

    // The round and one record per seat, even a Score of 0.
    assert_eq!(stored.round.ended, RoundEnd::Played);
    assert_eq!(stored.round.records.len(), 2);
    assert_eq!(stored_rounds(&app), vec![stored.round.clone()]);

    // The Stage gets every Player's result, ranked.
    let results = stored.results.clone().unwrap();
    assert_eq!(results.ended, SongEnd::Played);
    assert_eq!(results.request_id, room.request);
    let party = &room.party;
    let colour = |member: PartyMemberId| {
        party
            .members
            .iter()
            .find(|m| m.member_id == member)
            .unwrap()
            .colour
    };
    assert_eq!(
        results.players,
        vec![
            PlayerResult {
                member_id: room.members[0],
                player: of(&bo),
                name: "Bo".into(),
                avatar: star(),
                colour: colour(room.members[0]),
                mic: seats[0].mic.clone(),
                voice: None,
                difficulty: Difficulty::Medium,
                total: 5000,
                notes: 2500,
                golden: 0,
                line_bonus: 2500,
                place: 1,
                rank_title_band: 4,
                new_high_score: true,
                mic_lost: false,
                unfinished: false,
            },
            PlayerResult {
                member_id: room.members[1],
                player: guest("Cy"),
                name: "Cy".into(),
                avatar: star(),
                colour: PaletteKey::Grape,
                mic: seats[1].mic.clone(),
                voice: None,
                difficulty: Difficulty::Medium,
                total: 0,
                notes: 0,
                golden: 0,
                line_bonus: 0,
                place: 2,
                rank_title_band: 0,
                new_high_score: false,
                mic_lost: true,
                unfinished: true,
            },
        ]
    );
    assert_eq!(
        seats[0].mic,
        Some(MicKey::Phone {
            phone_id: phone_id(1).0
        })
    );

    // The whole Party moves to the results; each Phone finds its own.
    let (party, change) = room.hear().await;
    assert_eq!(
        change,
        ChangeEvent {
            actor: Actor::Stage,
            event: PartyEvent::ResultsShown(RequestChange {
                request_id: room.request,
                song_id: song.id,
                title: "Solo".into(),
            }),
        }
    );
    assert_eq!(party.results, Some(results.clone()));
    assert_eq!(party.playing, None);
    assert_eq!(party.head, None);
    assert!(party.queue.is_empty());
    for (n, _) in room.phones.iter().enumerate() {
        let mine = MicKey::Phone {
            phone_id: phone_id(u32::try_from(n).unwrap() + 1).0,
        };
        let own: Vec<_> = results
            .players
            .iter()
            .filter(|r| r.mic.as_ref() == Some(&mine))
            .collect();
        assert_eq!(own.len(), 1);
        assert_eq!(own[0].member_id, room.members[n]);
    }

    // Storing Bo's record set his last Difficulty and last sung.
    let bo_now: Profile = app.get_json(&format!("/api/profiles/{}", bo.id.0)).await;
    assert_eq!(bo_now.last_difficulty, Difficulty::Medium);
    assert!(bo_now.last_sung_at.is_some());

    // The results survive a restart, Player by Player.
    drop(room);
    let mut app = app;
    app.restart().await;
    let mut stage = app.connect_stage().await;
    let party = live_party(&mut stage).await.unwrap();
    assert_eq!(party.results, Some(results));
}

#[tokio::test]
async fn places_and_bands_over_four_players_with_ties() {
    let (app, song) = app_with_song().await;
    let colours = [
        PaletteKey::Sky,
        PaletteKey::Lime,
        PaletteKey::Cherry,
        PaletteKey::Teal,
    ];
    let mut profiles = Vec::new();
    for (n, colour) in colours.into_iter().enumerate() {
        profiles.push(create_profile(&app, &format!("P{n}"), colour).await);
    }
    let who: Vec<Result<&Profile, &str>> = profiles.iter().map(Ok).collect();
    let mut room = room(&app, &song, &who).await;
    room.start().await;
    let body = outcome(
        &song,
        &room,
        RoundEnd::Ended,
        vec![
            score(of(&profiles[0]), 1249),
            score(of(&profiles[1]), 8750),
            score(of(&profiles[2]), 1249),
            score(of(&profiles[3]), 8750),
        ],
    );
    let results = store(&app, &body).await.results.unwrap();
    assert_eq!(results.ended, SongEnd::Ended);
    assert_eq!(
        summary(&results.players),
        vec![
            ("P1".into(), 8750, 1, 7),
            ("P3".into(), 8750, 1, 7),
            ("P0".into(), 1249, 3, 0),
            ("P2".into(), 1249, 3, 0),
        ]
    );
}

#[tokio::test]
async fn retrying_the_same_outcome_after_a_lost_response_stores_it_once() {
    let (app, song) = app_with_song().await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let mut room = room(&app, &song, &[Ok(&bo)]).await;
    room.start().await;
    let body = outcome(&song, &room, RoundEnd::Ended, vec![score(of(&bo), 700)]);
    let first = store(&app, &body).await;
    room.hear().await;
    let again = store(&app, &body).await;
    assert_eq!(again, first);
    assert_eq!(stored_rounds(&app).len(), 1);
    assert_eq!(stored_rounds(&app)[0].records.len(), 1);
    // The Party heard the results once.
    room.stage.send(&ClientMessage::Ping { nonce: 5 }).await;
    assert_eq!(
        recv(&mut room.stage).await,
        ServerMessage::Pong { nonce: 5 }
    );
}

#[tokio::test]
async fn a_skip_stores_a_skipped_round_with_no_records_and_no_results() {
    let (app, song) = app_with_song().await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let mut room = room(&app, &song, &[Ok(&bo)]).await;
    room.start().await;
    room.control(SongControl::Skip).await;
    let body = outcome(&song, &room, RoundEnd::Skipped, vec![]);
    let stored = store(&app, &body).await;
    assert_eq!(stored.round.ended, RoundEnd::Skipped);
    assert!(stored.round.records.is_empty());
    assert_eq!(stored.results, None);
    assert_eq!(store(&app, &body).await, stored);
    assert_eq!(stored_rounds(&app).len(), 1);
    // The Party shows no results.
    room.stage.send(&ClientMessage::Ping { nonce: 6 }).await;
    assert_eq!(
        recv(&mut room.stage).await,
        ServerMessage::Pong { nonce: 6 }
    );
    assert_eq!(room.party.results, None);
}

#[tokio::test]
async fn nothing_is_stored_for_a_song_that_is_not_playing_or_of_another_party() {
    let (mut app, song) = app_with_song().await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let mut room = room(&app, &song, &[Ok(&bo)]).await;
    let body = outcome(&song, &room, RoundEnd::Played, vec![score(of(&bo), 700)]);

    // The Line-up still waits: nothing plays.
    let (status, json) = post(&app, &body).await;
    assert_eq!(status, StatusCode::CONFLICT, "{json}");
    assert_eq!(
        serde_json::from_value::<UserMessage>(json).unwrap(),
        UserMessage::NoSongPlaying
    );

    // Another Party's outcome.
    room.start().await;
    let mut other = body.clone();
    other.party_id.0 = "another-party".into();
    let (status, _) = post(&app, &other).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Scores that do not match the seats.
    let mut wrong = body.clone();
    wrong.scores[0].player = guest("Nobody");
    let (status, _) = post(&app, &wrong).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let mut missing = body.clone();
    missing.scores.clear();
    let (status, _) = post(&app, &missing).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // A server restart aborts the Song: the outcome arriving after it is
    // refused.
    drop(room);
    app.restart().await;
    let (status, _) = post(&app, &body).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(stored_rounds(&app).is_empty());
}

#[tokio::test]
async fn a_song_id_of_another_song_is_refused() {
    let (app, song) = app_with_song().await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let mut room = room(&app, &song, &[Ok(&bo)]).await;
    room.start().await;
    let mut body = outcome(&song, &room, RoundEnd::Played, vec![score(of(&bo), 700)]);
    body.song_id = SongId(song.id.0 + 100);
    let (status, _) = post(&app, &body).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(stored_rounds(&app).is_empty());
}
