//! Surviving drops mid-Song (#88), over real HTTP and WebSocket: a Stage
//! that drops or is taken over and a server restart abort the Song with no
//! results, leaving its Request at the head with its Line-up; a seated Phone
//! that drops keeps its seat and comes back as that seat's Mic; a Phone back
//! after its Song learns whether the Stage shows results.

use std::path::Path;

use futures_util::StreamExt;
use openstar_protocol::library::{SongDetail, SongId, SongList, SongSummary};
use openstar_protocol::mics::MicKey;
use openstar_protocol::pitch::PitchReading;
use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey, Profile};
use openstar_protocol::scoring::{
    BeatRange, BeatValue, MicKind, PlayerScore, RoundEnd, RoundMode, RoundOutcome, ScorePlayer,
};
use openstar_protocol::{
    Actor, ChangeEvent, ClientMessage, Identity, JoinAs, JoinCode, LineUp, MicId, PartyEvent,
    PartyMemberId, PartySnapshot, PhoneId, RequestChange, RequestId, ServerMessage, SongControl,
};
use openstar_test_harness::{TestApp, WsClient};

const PHONE: &str = "4b1d8f0e-0000-4000-8000-000000000088";

fn write_song(folder: &Path, title: &str) {
    std::fs::create_dir_all(folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:Placeholder\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n"),
    )
    .unwrap();
}

/// A fresh app whose Library holds the one-Voice Song "Solo".
async fn app_with_solo() -> (TestApp, SongId) {
    let mut app = TestApp::start().await;
    write_song(&app.songs_dir().join("Solo"), "Solo");
    app.restart().await;
    let songs: Vec<SongSummary> = app.get_json::<SongList>("/api/songs").await.songs;
    (app, songs[0].id)
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

async fn live_party(socket: &mut WsClient) -> PartySnapshot {
    match recv(socket).await {
        ServerMessage::LiveState {
            party: Some(party), ..
        } => party,
        other => panic!("expected the live state with a Party, got {other:?}"),
    }
}

/// Nothing more was sent to `socket`: a Ping is answered next.
async fn hears_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 77 });
}

/// Drops `socket` as a network drop or a crash would, and waits until the
/// server has handled the close.
async fn drop_connection(socket: WsClient) {
    let mut socket = socket.into_socket();
    socket.close(None).await.unwrap();
    while socket.next().await.is_some_and(|frame| frame.is_ok()) {}
}

fn reading(capture_ms: f64) -> PitchReading {
    PitchReading {
        capture_ms,
        pitch: Some(69.25),
        clarity: 0.93,
        loudness: -24.5,
    }
}

/// `phone` sends a reading, which reaches `stage` as `mic`'s.
async fn sings(phone: &mut WsClient, stage: &mut WsClient, mic: &MicId, capture_ms: f64) {
    phone
        .send(&ClientMessage::PitchReading {
            reading: reading(capture_ms),
            input: None,
        })
        .await;
    assert_eq!(
        recv(stage).await,
        ServerMessage::PitchReading {
            mic: mic.clone(),
            reading: reading(capture_ms)
        }
    );
}

async fn create_profile(app: &TestApp, name: &str) -> Profile {
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(&NewProfile {
            name: name.to_owned(),
            avatar: Avatar::BuiltIn {
                key: AvatarKey::Star,
            },
            favourite_colour: PaletteKey::Sky,
        })
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    response.json().await.unwrap()
}

/// Joins Mia's Phone; returns its socket and her member id, past what the
/// join sent it. `stage` hears the join.
async fn join_mia(
    app: &TestApp,
    stage: &mut WsClient,
    code: &JoinCode,
) -> (WsClient, PartyMemberId) {
    let mia = create_profile(app, "Mia").await;
    let mut phone = app.connect_ws().await;
    live_party(&mut phone).await;
    phone
        .send(&ClientMessage::Join {
            phone_id: PhoneId(PHONE.into()),
            join_code: code.clone(),
            join_as: JoinAs::Profile {
                profile_id: mia.id,
            },
        })
        .await;
    let member_id = match recv(&mut phone).await {
        ServerMessage::PhoneStatus {
            member_id: Some(member_id),
        } => member_id,
        other => panic!("expected the Phone's status, got {other:?}"),
    };
    party_changed(&mut phone).await;
    party_changed(stage).await;
    (phone, member_id)
}

/// A Stage and Mia's Phone, with Mia's Request for `song` playing on her
/// Phone's mic. Returns the Line-up as it waited before Start, and the
/// Party while the Song plays.
struct Playing {
    stage: WsClient,
    phone: WsClient,
    mia: PartyMemberId,
    waiting: LineUp,
    party: PartySnapshot,
}

async fn mia_sings(app: &TestApp, song: SongId) -> Playing {
    let mut stage = app.connect_stage().await;
    live_party(&mut stage).await;
    let (party, _) = party_changed(&mut stage).await;
    let (mut phone, mia) = join_mia(app, &mut stage, &party.join_code).await;
    phone
        .send(&ClientMessage::AddRequest {
            song_id: song,
            requested_players: None,
        })
        .await;
    let (party, _) = party_changed(&mut stage).await;
    party_changed(&mut phone).await;
    let waiting = party.line_up.expect("Mia's Line-up waits");
    assert!(waiting.can_start);
    phone
        .send(&ClientMessage::ControlSong {
            request_id: waiting.request_id,
            control: SongControl::Start,
        })
        .await;
    let (party, _) = party_changed(&mut stage).await;
    party_changed(&mut phone).await;
    assert!(matches!(
        recv(&mut stage).await,
        ServerMessage::ControlSong {
            control: SongControl::Start,
            ..
        }
    ));
    assert!(party.playing.is_some());
    Playing {
        stage,
        phone,
        mia,
        waiting,
        party,
    }
}

/// The Stage's outcome of `party`'s playing Song, played out, a Score of 0
/// per seat.
async fn post_round(app: &TestApp, party: &PartySnapshot) -> reqwest::Response {
    let playing = party.playing.clone().expect("a Song played");
    let song: SongDetail = app
        .get_json(&format!("/api/songs/{}", playing.song_id.0))
        .await;
    let range = BeatRange {
        first_beat: 0,
        last_beat: 3,
    };
    let scores = party
        .line_up
        .as_ref()
        .unwrap()
        .seats
        .iter()
        .map(|seat| {
            let member = party
                .members
                .iter()
                .find(|member| member.member_id == seat.member_id)
                .unwrap();
            PlayerScore {
                player: match &member.identity {
                    Identity::Profile { profile_id } => ScorePlayer::Profile {
                        profile_id: *profile_id,
                    },
                    Identity::Guest { name, .. } => ScorePlayer::Guest { name: name.clone() },
                },
                voice: 0,
                difficulty: seat.difficulty,
                total: 0,
                notes: 0,
                golden: 0,
                line_bonus: 0,
                mic_kind: MicKind::Phone,
                unfinished: false,
                mic_lost: false,
                beat_range: range,
                beat_values: vec![BeatValue::NoVoice; range.len()],
            }
        })
        .collect();
    app.http()
        .post(app.url("/api/rounds"))
        .json(&RoundOutcome {
            song_id: playing.song_id,
            request_id: playing.request_id,
            note_fingerprint: song.note_fingerprint,
            party_id: party.party_id.clone(),
            mode: RoundMode::Normal,
            started_at_ms: 1_700_000_000_000,
            ended: RoundEnd::Played,
            scores,
        })
        .send()
        .await
        .unwrap()
}

/// A late outcome for the Song that `playing` shows playing is refused:
/// no round, results or Score records are stored for it.
async fn stores_nothing(app: &TestApp, playing: &PartySnapshot) {
    let response = post_round(app, playing).await;
    assert_eq!(response.status(), 409);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["code"], "noSongPlaying");
}

/// The Line-up waits again as it did before Start, the Request at the head
/// and the Queue unchanged, with no results.
fn waits_again(party: &PartySnapshot, before: &PartySnapshot, waiting: &LineUp) {
    assert_eq!(party.playing, None);
    assert_eq!(party.results, None);
    assert_eq!(party.head, Some(waiting.request_id));
    assert_eq!(party.queue, before.queue);
    assert_eq!(party.members, before.members);
    let line_up = party.line_up.as_ref().expect("the Line-up waits again");
    assert_eq!(line_up, waiting);
}

fn aborted(request: RequestId, song: SongId) -> ChangeEvent {
    ChangeEvent {
        actor: Actor::Stage,
        event: PartyEvent::SongAborted(RequestChange {
            request_id: request,
            song_id: song,
            title: "Solo".into(),
        }),
    }
}

#[tokio::test]
async fn a_stage_that_drops_mid_song_aborts_it_and_the_returning_stage_shows_the_line_up() {
    let (app, solo) = app_with_solo().await;
    let Playing {
        stage,
        mut phone,
        waiting,
        party: playing,
        ..
    } = mia_sings(&app, solo).await;
    let request = waiting.request_id;

    // The Stage's browser crashes.
    drop_connection(stage).await;
    let (party, change) = party_changed(&mut phone).await;
    assert_eq!(change, aborted(request, solo));
    waits_again(&party, &playing, &waiting);

    // The Stage comes back to the same Line-up, which can start again.
    let mut stage = app.connect_stage().await;
    let party = live_party(&mut stage).await;
    waits_again(&party, &playing, &waiting);
    hears_nothing(&mut stage).await;
    stores_nothing(&app, &playing).await;
    hears_nothing(&mut phone).await;
}

#[tokio::test]
async fn a_takeover_mid_song_aborts_it_and_the_new_stage_shows_the_line_up() {
    let (app, solo) = app_with_solo().await;
    let Playing {
        mut stage,
        mut phone,
        waiting,
        party: playing,
        ..
    } = mia_sings(&app, solo).await;
    let request = waiting.request_id;

    // Another browser takes the Stage: it is told the Line-up waits, and
    // then hears the abort like everyone else.
    let mut new_stage = app.connect_stage().await;
    let party = live_party(&mut new_stage).await;
    waits_again(&party, &playing, &waiting);
    assert_eq!(recv(&mut stage).await, ServerMessage::StageMoved);
    for socket in [&mut stage, &mut phone, &mut new_stage] {
        let (party, change) = party_changed(socket).await;
        assert_eq!(change, aborted(request, solo));
        waits_again(&party, &playing, &waiting);
    }
    stores_nothing(&app, &playing).await;

    // The Song can start again on the new Stage.
    phone
        .send(&ClientMessage::ControlSong {
            request_id: request,
            control: SongControl::Start,
        })
        .await;
    let (party, _) = party_changed(&mut new_stage).await;
    assert!(party.playing.is_some());
}

#[tokio::test]
async fn a_restart_mid_song_leaves_the_request_at_the_head_and_phones_reconnect_silently() {
    let (mut app, solo) = app_with_solo().await;
    let Playing {
        stage,
        phone,
        mia,
        waiting,
        party: playing,
    } = mia_sings(&app, solo).await;

    drop((stage, phone));
    app.restart().await;

    let mut stage = app.connect_stage().await;
    let party = live_party(&mut stage).await;
    waits_again(&party, &playing, &waiting);
    hears_nothing(&mut stage).await;

    // Mia's Phone comes back by itself: the same Player, nobody else told.
    let mut phone = app.connect_ws().await;
    let party = live_party(&mut phone).await;
    waits_again(&party, &playing, &waiting);
    phone
        .send(&ClientMessage::Hello {
            phone_id: PhoneId(PHONE.into()),
        })
        .await;
    assert_eq!(
        recv(&mut phone).await,
        ServerMessage::PhoneStatus {
            member_id: Some(mia)
        }
    );
    hears_nothing(&mut stage).await;
    stores_nothing(&app, &playing).await;
}

#[tokio::test]
async fn a_seated_phone_that_drops_mid_song_keeps_its_seat_and_is_its_mic_again() {
    let (app, solo) = app_with_solo().await;
    let Playing {
        mut stage,
        mut phone,
        mia,
        party: playing,
        ..
    } = mia_sings(&app, solo).await;
    let mic = MicId::Phone {
        phone_id: PhoneId(PHONE.into()),
    };
    let seat = playing.line_up.clone().unwrap().seats[0].clone();
    assert_eq!(
        (seat.member_id, &seat.mic),
        (
            mia,
            &Some(MicKey::Phone {
                phone_id: PHONE.into()
            })
        )
    );

    sings(&mut phone, &mut stage, &mic, 1.0).await;

    // Mia's Phone drops off the Wi-Fi: the Stage hears its Mic closed, and
    // nothing else. The Song plays on, unpaused, and she keeps her seat and
    // her colour.
    drop_connection(phone).await;
    assert_eq!(
        recv(&mut stage).await,
        ServerMessage::MicClosed { mic: mic.clone() }
    );
    hears_nothing(&mut stage).await;
    let mut onlooker = app.connect_ws().await;
    let party = live_party(&mut onlooker).await;
    assert_eq!(party.playing, playing.playing);
    assert!(!party.playing.as_ref().unwrap().paused);
    assert_eq!(party.line_up, playing.line_up);
    assert_eq!(party.members, playing.members);

    // It comes back with its Phone id during the same Song: its readings
    // reach the Stage under the seat's Mic, and its seat's Score reaches it.
    let mut again = app.connect_ws().await;
    let party = live_party(&mut again).await;
    assert_eq!(party.playing, playing.playing);
    again
        .send(&ClientMessage::Hello {
            phone_id: PhoneId(PHONE.into()),
        })
        .await;
    assert_eq!(
        recv(&mut again).await,
        ServerMessage::PhoneStatus {
            member_id: Some(mia)
        }
    );
    sings(&mut again, &mut stage, &mic, 3.0).await;
    let request_id = playing.playing.unwrap().request_id;
    stage
        .send(&ClientMessage::ReportLineScore {
            request_id,
            seat: 0,
            total: 1200,
        })
        .await;
    assert_eq!(
        recv(&mut again).await,
        ServerMessage::LineScore {
            request_id,
            total: 1200
        }
    );
}

#[tokio::test]
async fn a_phone_back_after_its_song_is_told_whether_the_stage_shows_results() {
    let (app, solo) = app_with_solo().await;
    let Playing {
        mut stage,
        mut phone,
        party: playing,
        ..
    } = mia_sings(&app, solo).await;
    let mic = MicId::Phone {
        phone_id: PhoneId(PHONE.into()),
    };
    sings(&mut phone, &mut stage, &mic, 1.0).await;

    // Mia's Phone locks during the Song, which plays out.
    drop_connection(phone).await;
    assert_eq!(recv(&mut stage).await, ServerMessage::MicClosed { mic });
    assert_eq!(post_round(&app, &playing).await.status(), 201);
    party_changed(&mut stage).await;

    // Back while the Stage shows the results: the snapshot holds them, with
    // her result on her Phone's Mic.
    let mut again = app.connect_ws().await;
    let party = live_party(&mut again).await;
    let results = party.results.expect("the Stage shows results");
    assert_eq!(results.request_id, playing.playing.unwrap().request_id);
    assert_eq!(
        results.players[0].mic,
        Some(MicKey::Phone {
            phone_id: PHONE.into()
        })
    );
    drop_connection(again).await;

    // Back after Next: no results, so the Phone shows its Remote.
    stage.send(&ClientMessage::CloseResults).await;
    party_changed(&mut stage).await;
    let mut again = app.connect_ws().await;
    let party = live_party(&mut again).await;
    assert_eq!(party.results, None);
    assert_eq!(party.playing, None);
}
