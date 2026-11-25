//! Playing a Request over real HTTP and WebSocket, with a test Stage client
//! standing in for the Stage's playback: Start, Pause, Resume, Restart,
//! End and the results with Next or Done, and Skip, checking the Queue and
//! Party state after each step and what the Stage is told to do.

use std::path::Path;

use openstar_protocol::library::{SongId, SongList, SongSummary};
use openstar_protocol::profile::{Avatar, NewProfile};
use openstar_protocol::profile::{AvatarKey, Difficulty, PaletteKey, Profile};
use openstar_protocol::{
    Actor, ChangeEvent, ClientMessage, JoinAs, JoinCode, LineUpEdit, PartyEvent, PartyMemberId,
    PartySnapshot, PhoneId, PlayingSong, RequestChange, RequestId, SeatWho, ServerMessage,
    SongControl, SongEnd, SongResults, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

fn star() -> Avatar {
    Avatar::BuiltIn {
        key: AvatarKey::Star,
    }
}

fn write_song(folder: &Path, title: &str) {
    std::fs::create_dir_all(folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:Placeholder\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n"),
    )
    .unwrap();
}

/// A fresh app whose Library holds the one-Voice Songs "Solo" and "Encore".
async fn app_with_songs() -> (TestApp, SongId, SongId) {
    let mut app = TestApp::start().await;
    write_song(&app.songs_dir().join("Solo"), "Solo");
    write_song(&app.songs_dir().join("Encore"), "Encore");
    app.restart().await;
    let songs: Vec<SongSummary> = app.get_json::<SongList>("/api/songs").await.songs;
    let id = |title: &str| songs.iter().find(|song| song.title == title).unwrap().id;
    let (solo, encore) = (id("Solo"), id("Encore"));
    (app, solo, encore)
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

/// Every socket hears the same change; returns it.
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

/// What the Stage is told to do with the head's Song next.
async fn stage_told(stage: &mut WsClient) -> (RequestId, SongId, SongControl) {
    match recv(stage).await {
        ServerMessage::ControlSong {
            request_id,
            song_id,
            control,
        } => (request_id, song_id, control),
        other => panic!("expected a Song control for the Stage, got {other:?}"),
    }
}

/// Nothing more was sent to `socket`: a Ping is answered next.
async fn hears_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 77 });
}

async fn live_party(socket: &mut WsClient) -> Option<PartySnapshot> {
    match recv(socket).await {
        ServerMessage::LiveState { party, .. } => party,
        other => panic!("expected the live state first, got {other:?}"),
    }
}

async fn refused(socket: &mut WsClient, message: ClientMessage) -> UserMessage {
    socket.send(&message).await;
    match recv(socket).await {
        ServerMessage::Rejected { reason } => reason,
        other => panic!("expected a refusal, got {other:?}"),
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

async fn first_stage(app: &TestApp) -> (WsClient, JoinCode) {
    let mut stage = app.connect_stage().await;
    live_party(&mut stage).await;
    let (party, _) = party_changed(&mut stage).await;
    (stage, party.join_code)
}

fn phone_id(n: u32) -> PhoneId {
    PhoneId(format!("4b1d8f0e-0000-4000-8000-{n:012}"))
}

/// Joins Phone `n` as Profile `profile`; returns its socket and member id,
/// past what the join sent it. Every socket in `others` hears the join.
async fn joined(
    app: &TestApp,
    others: &mut [&mut WsClient],
    code: &JoinCode,
    n: u32,
    profile: &Profile,
) -> (WsClient, PartyMemberId) {
    let mut socket = app.connect_ws().await;
    live_party(&mut socket).await;
    socket
        .send(&ClientMessage::Join {
            phone_id: phone_id(n),
            join_code: code.clone(),
            join_as: JoinAs::Profile {
                profile_id: profile.id,
            },
        })
        .await;
    let member_id = match recv(&mut socket).await {
        ServerMessage::PhoneStatus {
            member_id: Some(member_id),
        } => member_id,
        other => panic!("expected Phone {n}'s status, got {other:?}"),
    };
    party_changed(&mut socket).await;
    for other in others.iter_mut() {
        party_changed(other).await;
    }
    (socket, member_id)
}

fn control(request_id: RequestId, control: SongControl) -> ClientMessage {
    ClientMessage::ControlSong {
        request_id,
        control,
    }
}

fn change(request_id: RequestId, song_id: SongId, title: &str) -> RequestChange {
    RequestChange {
        request_id,
        song_id,
        title: title.to_owned(),
    }
}

/// A Stage and Bo's Phone, with Bo's Request for `song` at the head: its
/// Line-up seats Bo on Bo's Phone and can start.
async fn bo_with_a_request(
    app: &TestApp,
    song: SongId,
) -> (WsClient, WsClient, PartyMemberId, RequestId, JoinCode) {
    let (mut stage, code) = first_stage(app).await;
    let bo = create_profile(app, "Bo", PaletteKey::Sky).await;
    let (mut bo_phone, bo_id) = joined(app, &mut [&mut stage], &code, 1, &bo).await;
    bo_phone
        .send(&ClientMessage::AddRequest {
            song_id: song,
            requested_players: None,
        })
        .await;
    let (party, _) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    let line_up = party.line_up.unwrap();
    assert!(line_up.can_start);
    (stage, bo_phone, bo_id, line_up.request_id, code)
}

#[tokio::test]
async fn start_needs_a_valid_line_up_and_then_fixes_it_until_the_song_ends() {
    let (app, solo, _encore) = app_with_songs().await;
    let (mut stage, mut bo_phone, bo_id, request, _code) = bo_with_a_request(&app, solo).await;

    // Taking Bo off the Song leaves an empty Line-up, which cannot start.
    stage
        .send(&ClientMessage::EditLineUp {
            request_id: request,
            edit: LineUpEdit::RemoveSeat { seat: 0 },
        })
        .await;
    all_hear(&mut [&mut stage, &mut bo_phone]).await;
    assert_eq!(
        refused(&mut bo_phone, control(request, SongControl::Start)).await,
        UserMessage::LineUpNotReady
    );
    assert_eq!(
        refused(&mut stage, control(RequestId(999), SongControl::Start)).await,
        UserMessage::LineUpNotWaiting
    );
    stage
        .send(&ClientMessage::EditLineUp {
            request_id: request,
            edit: LineUpEdit::AddSeat {
                who: SeatWho::Member { member_id: bo_id },
            },
        })
        .await;
    all_hear(&mut [&mut stage, &mut bo_phone]).await;

    // Bo's Phone presses Start without ever turning its mic on: Start does
    // not wait for it. Everyone sees 'playing', then the Stage is told.
    bo_phone.send(&control(request, SongControl::Start)).await;
    let (party, event) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    assert_eq!(
        event,
        ChangeEvent {
            actor: Actor::Member { member_id: bo_id },
            event: PartyEvent::SongStarted(change(request, solo, "Solo")),
        }
    );
    assert_eq!(
        party.playing,
        Some(PlayingSong {
            request_id: request,
            song_id: solo,
            paused: false,
        })
    );
    assert_eq!(party.head, Some(request));
    let line_up = party.line_up.clone().unwrap();
    assert_eq!(line_up.seats.len(), 1);
    assert!(!line_up.can_start, "a playing Song cannot start again");
    assert!(party.members[0].singing);
    assert_eq!(
        stage_told(&mut stage).await,
        (request, solo, SongControl::Start)
    );
    hears_nothing(&mut bo_phone).await;

    // The Line-up and every seat's Difficulty are fixed until the Song ends.
    assert_eq!(
        refused(
            &mut stage,
            ClientMessage::EditLineUp {
                request_id: request,
                edit: LineUpEdit::SetDifficulty {
                    seat: 0,
                    difficulty: Difficulty::Hard,
                },
            }
        )
        .await,
        UserMessage::LineUpNotWaiting
    );
    assert_eq!(
        refused(
            &mut bo_phone,
            ClientMessage::SetMyDifficulty {
                difficulty: Difficulty::Hard
            }
        )
        .await,
        UserMessage::DifficultyLocked
    );
    assert_eq!(
        refused(&mut stage, control(request, SongControl::Start)).await,
        UserMessage::LineUpNotWaiting
    );
    // The playing Request cannot be removed or moved: Skip or End does that.
    assert_eq!(
        refused(
            &mut stage,
            ClientMessage::RemoveRequest {
                request_id: request
            }
        )
        .await,
        UserMessage::RequestPlaying
    );
    assert_eq!(
        refused(
            &mut bo_phone,
            ClientMessage::MoveRequest {
                request_id: request,
                to: openstar_protocol::QueueMove::Down,
            }
        )
        .await,
        UserMessage::RequestCannotMove
    );
    // A seated Player cannot leave mid-Song.
    assert_eq!(
        refused(&mut bo_phone, ClientMessage::LeaveParty).await,
        UserMessage::MemberSinging
    );
}

#[tokio::test]
async fn pause_resume_and_restart_come_from_any_remote_and_reach_the_stage() {
    let (app, solo, _encore) = app_with_songs().await;
    let (mut stage, mut bo_phone, bo_id, request, _code) = bo_with_a_request(&app, solo).await;

    // Nothing plays yet.
    assert_eq!(
        refused(&mut bo_phone, control(request, SongControl::Pause)).await,
        UserMessage::NoSongPlaying
    );
    stage.send(&control(request, SongControl::Start)).await;
    all_hear(&mut [&mut stage, &mut bo_phone]).await;
    stage_told(&mut stage).await;

    // Pause from the Phone.
    bo_phone.send(&control(request, SongControl::Pause)).await;
    let (party, event) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    assert_eq!(event.actor, Actor::Member { member_id: bo_id });
    assert_eq!(
        event.event,
        PartyEvent::SongPaused(change(request, solo, "Solo"))
    );
    assert!(party.playing.unwrap().paused);
    assert_eq!(
        stage_told(&mut stage).await,
        (request, solo, SongControl::Pause)
    );

    // Pausing a paused Song changes nothing and tells nobody.
    bo_phone.send(&control(request, SongControl::Pause)).await;
    hears_nothing(&mut bo_phone).await;
    hears_nothing(&mut stage).await;

    // Resume from the Stage itself; the Stage is still told to act.
    stage.send(&control(request, SongControl::Resume)).await;
    let (party, event) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    assert_eq!(event.actor, Actor::Stage);
    assert!(!party.playing.unwrap().paused);
    assert_eq!(
        stage_told(&mut stage).await,
        (request, solo, SongControl::Resume)
    );

    // Restart unpauses the Song too.
    bo_phone.send(&control(request, SongControl::Pause)).await;
    all_hear(&mut [&mut stage, &mut bo_phone]).await;
    stage_told(&mut stage).await;
    bo_phone.send(&control(request, SongControl::Restart)).await;
    let (party, event) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    assert_eq!(
        event.event,
        PartyEvent::SongRestarted(change(request, solo, "Solo"))
    );
    assert!(!party.playing.unwrap().paused);
    assert_eq!(
        stage_told(&mut stage).await,
        (request, solo, SongControl::Restart)
    );

    // A control for another Request is refused, and a browser that has not
    // joined may not control at all.
    assert_eq!(
        refused(&mut bo_phone, control(RequestId(999), SongControl::Pause)).await,
        UserMessage::NoSongPlaying
    );
    let mut stranger = app.connect_ws().await;
    live_party(&mut stranger).await;
    assert_eq!(
        refused(&mut stranger, control(request, SongControl::Pause)).await,
        UserMessage::NotInParty
    );
}

#[tokio::test]
async fn end_shows_results_until_next_brings_up_the_next_line_up() {
    let (mut app, solo, encore) = app_with_songs().await;
    let (mut stage, mut bo_phone, bo_id, request, _code) = bo_with_a_request(&app, solo).await;
    stage
        .send(&ClientMessage::AddRequest {
            song_id: encore,
            requested_players: None,
        })
        .await;
    let (party, _) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    let encore_request = party.queue[1].request_id;
    stage.send(&control(request, SongControl::Start)).await;
    all_hear(&mut [&mut stage, &mut bo_phone]).await;
    stage_told(&mut stage).await;

    // End is passed to the Stage; the Song plays on until the Stage
    // reports its results.
    bo_phone.send(&control(request, SongControl::End)).await;
    let (party, event) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    assert_eq!(
        event.event,
        PartyEvent::SongEnded(change(request, solo, "Solo"))
    );
    assert!(party.playing.is_some());
    assert_eq!(
        stage_told(&mut stage).await,
        (request, solo, SongControl::End)
    );

    // Only the Stage reports results.
    assert_eq!(
        refused(
            &mut bo_phone,
            ClientMessage::ReachedResults {
                request_id: request,
                ended: SongEnd::Ended,
            }
        )
        .await,
        UserMessage::NotTheStage
    );
    stage
        .send(&ClientMessage::ReachedResults {
            request_id: request,
            ended: SongEnd::Ended,
        })
        .await;
    let (party, event) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    assert_eq!(
        event,
        ChangeEvent {
            actor: Actor::Stage,
            event: PartyEvent::ResultsShown(change(request, solo, "Solo")),
        }
    );
    let results = Some(SongResults {
        request_id: request,
        song_id: solo,
        ended: SongEnd::Ended,
    });
    assert_eq!(party.results, results);
    assert_eq!(party.playing, None);
    assert_eq!(party.head, None);
    assert_eq!(party.line_up, None);
    assert_eq!(
        party.queue.iter().map(|r| r.request_id).collect::<Vec<_>>(),
        vec![encore_request]
    );
    assert!(!party.members[0].singing);

    // Results stay while Requests are added, and across a restart.
    bo_phone
        .send(&ClientMessage::AddRequest {
            song_id: solo,
            requested_players: None,
        })
        .await;
    let (party, _) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    assert_eq!(party.head, None);
    assert_eq!(party.results, results);
    drop((stage, bo_phone));
    app.restart().await;
    let mut stage = app.connect_stage().await;
    let party = live_party(&mut stage).await.unwrap();
    assert_eq!(party.results, results);
    assert_eq!(party.head, None);
    assert_eq!(party.queue.len(), 2);

    // Next (from any Remote) brings up the next Request's Line-up.
    stage.send(&ClientMessage::CloseResults).await;
    let (party, event) = party_changed(&mut stage).await;
    assert_eq!(event.event, PartyEvent::ResultsClosed);
    assert_eq!(party.results, None);
    assert_eq!(party.head, Some(encore_request));
    assert_eq!(party.line_up.unwrap().request_id, encore_request);
    assert_eq!(
        refused(&mut stage, ClientMessage::CloseResults).await,
        UserMessage::NoResults
    );
    let _ = bo_id;
}

#[tokio::test]
async fn done_after_the_last_songs_results_leads_to_the_song_browser() {
    let (app, solo, _encore) = app_with_songs().await;
    let (mut stage, mut bo_phone, _bo_id, request, _code) = bo_with_a_request(&app, solo).await;
    bo_phone.send(&control(request, SongControl::Start)).await;
    all_hear(&mut [&mut stage, &mut bo_phone]).await;
    stage_told(&mut stage).await;

    // The Song plays to its end.
    stage
        .send(&ClientMessage::ReachedResults {
            request_id: request,
            ended: SongEnd::Played,
        })
        .await;
    let (party, _) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    assert_eq!(party.results.unwrap().ended, SongEnd::Played);
    assert!(party.queue.is_empty());

    bo_phone.send(&ClientMessage::CloseResults).await;
    let (party, _) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    assert_eq!(party.results, None);
    assert_eq!(party.head, None);
    assert_eq!(party.line_up, None);
    assert_eq!(party.playing, None);
}

#[tokio::test]
async fn skip_removes_the_request_without_results_and_brings_up_the_next_line_up() {
    let (app, solo, encore) = app_with_songs().await;
    let (mut stage, mut bo_phone, bo_id, request, _code) = bo_with_a_request(&app, solo).await;
    bo_phone
        .send(&ClientMessage::AddRequest {
            song_id: encore,
            requested_players: None,
        })
        .await;
    let (party, _) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    let encore_request = party.queue[1].request_id;
    stage.send(&control(request, SongControl::Start)).await;
    all_hear(&mut [&mut stage, &mut bo_phone]).await;
    stage_told(&mut stage).await;

    bo_phone.send(&control(request, SongControl::Skip)).await;
    let (party, event) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    assert_eq!(
        event.event,
        PartyEvent::SongSkipped(change(request, solo, "Solo"))
    );
    assert_eq!(party.playing, None);
    assert_eq!(party.results, None);
    assert_eq!(party.head, Some(encore_request));
    assert_eq!(party.queue.len(), 1);
    let line_up = party.line_up.unwrap();
    assert_eq!(line_up.request_id, encore_request);
    assert_eq!(line_up.seats[0].member_id, bo_id);
    assert_eq!(
        stage_told(&mut stage).await,
        (request, solo, SongControl::Skip)
    );
    // A second Skip for the same Song finds nothing playing.
    assert_eq!(
        refused(&mut stage, control(request, SongControl::Skip)).await,
        UserMessage::NoSongPlaying
    );

    // Skipping the last Song leads to the song browser.
    stage
        .send(&control(encore_request, SongControl::Start))
        .await;
    all_hear(&mut [&mut stage, &mut bo_phone]).await;
    stage_told(&mut stage).await;
    stage
        .send(&control(encore_request, SongControl::Skip))
        .await;
    let (party, _) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    assert!(party.queue.is_empty());
    assert_eq!(party.head, None);
    assert_eq!(party.line_up, None);
    assert_eq!(party.results, None);
}

#[tokio::test]
async fn a_phone_that_joins_during_a_song_is_a_remote_and_sings_in_the_next_line_up() {
    let (app, solo, encore) = app_with_songs().await;
    let (mut stage, mut bo_phone, _bo_id, request, code) = bo_with_a_request(&app, solo).await;
    stage
        .send(&ClientMessage::AddRequest {
            song_id: encore,
            requested_players: None,
        })
        .await;
    let (party, _) = all_hear(&mut [&mut stage, &mut bo_phone]).await;
    let encore_request = party.queue[1].request_id;
    stage.send(&control(request, SongControl::Start)).await;
    all_hear(&mut [&mut stage, &mut bo_phone]).await;
    stage_told(&mut stage).await;

    // Ann joins mid-Song: a Remote at once (she may pause), not singing.
    let ann = create_profile(&app, "Ann", PaletteKey::Lime).await;
    let (mut ann_phone, ann_id) =
        joined(&app, &mut [&mut stage, &mut bo_phone], &code, 2, &ann).await;
    ann_phone.send(&control(request, SongControl::Pause)).await;
    let (party, _) = all_hear(&mut [&mut stage, &mut bo_phone, &mut ann_phone]).await;
    stage_told(&mut stage).await;
    let ann_member = party
        .members
        .iter()
        .find(|member| member.member_id == ann_id)
        .unwrap();
    assert!(!ann_member.singing);
    assert!(
        party
            .line_up
            .unwrap()
            .seats
            .iter()
            .all(|seat| seat.member_id != ann_id)
    );
    // She cannot enter the Song already playing.
    assert_eq!(
        refused(
            &mut ann_phone,
            ClientMessage::EditLineUp {
                request_id: request,
                edit: LineUpEdit::AddSeat {
                    who: SeatWho::Member { member_id: ann_id },
                },
            }
        )
        .await,
        UserMessage::LineUpNotWaiting
    );

    // After the results, she takes a seat in the next Line-up.
    stage
        .send(&ClientMessage::ReachedResults {
            request_id: request,
            ended: SongEnd::Played,
        })
        .await;
    all_hear(&mut [&mut stage, &mut bo_phone, &mut ann_phone]).await;
    ann_phone.send(&ClientMessage::CloseResults).await;
    all_hear(&mut [&mut stage, &mut bo_phone, &mut ann_phone]).await;
    ann_phone
        .send(&ClientMessage::EditLineUp {
            request_id: encore_request,
            edit: LineUpEdit::AddSeat {
                who: SeatWho::Member { member_id: ann_id },
            },
        })
        .await;
    let (party, _) = all_hear(&mut [&mut stage, &mut bo_phone, &mut ann_phone]).await;
    let line_up = party.line_up.unwrap();
    assert_eq!(line_up.seats[0].member_id, ann_id);
    assert!(line_up.can_start);
}

#[tokio::test]
async fn start_is_refused_while_no_stage_is_open() {
    let (app, solo, _encore) = app_with_songs().await;
    let (stage, mut bo_phone, _bo_id, request, _code) = bo_with_a_request(&app, solo).await;
    stage.into_socket().close(None).await.unwrap();
    // Give the server a moment to see the Stage close.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(
        refused(&mut bo_phone, control(request, SongControl::Start)).await,
        UserMessage::NoStage
    );
}
