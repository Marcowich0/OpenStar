//! The Line-up over real HTTP and WebSocket: prefilled when a Request
//! reaches the head, following the head when it is removed, a Phone's
//! blocked-mic report, restart survival and New party.

use std::path::Path;

use openstar_protocol::library::{SongId, SongList, SongSummary};
use openstar_protocol::mics::MicKey;
use openstar_protocol::profile::{Avatar, AvatarKey, Difficulty, NewProfile, PaletteKey, Profile};
use openstar_protocol::{
    Actor, ChangeEvent, ClientMessage, JoinAs, JoinCode, LineUp, LineUpWarning, PartyEvent,
    PartyMemberId, PartySnapshot, PhoneId, Seat, SeatVoice, ServerMessage, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

/// Writes a playable Song (`song.txt` + a placeholder `song.mp3`) into `folder`;
/// with `duet`, it has two Voices.
fn write_song(folder: &Path, title: &str, duet: bool) {
    std::fs::create_dir_all(folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    let body = if duet {
        "P1\n: 0 4 0 La\nP2\n: 8 4 0 Lo\nE\n"
    } else {
        ": 0 4 0 La\nE\n"
    };
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:Placeholder\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n{body}"),
    )
    .unwrap();
}

/// A fresh app whose Library holds the one-Voice Song "Solo" and the duet
/// "Duet".
async fn app_with_songs() -> (TestApp, SongId, SongId) {
    let mut app = TestApp::start().await;
    write_song(&app.songs_dir().join("Solo"), "Solo", false);
    write_song(&app.songs_dir().join("Duet"), "Duet", true);
    app.restart().await;
    let songs: Vec<SongSummary> = app.get_json::<SongList>("/api/songs").await.songs;
    let id = |title: &str| {
        songs
            .iter()
            .find(|song| song.title == title)
            .unwrap_or_else(|| panic!("{title} is in the Library: {songs:?}"))
            .id
    };
    let (solo, duet) = (id("Solo"), id("Duet"));
    (app, solo, duet)
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

async fn live_party(socket: &mut WsClient) -> Option<PartySnapshot> {
    match recv(socket).await {
        ServerMessage::LiveState { party, .. } => party,
        other => panic!("expected the live state first, got {other:?}"),
    }
}

/// Asserts `socket` heard nothing since: a Ping's Pong comes next.
async fn heard_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 77 });
}

async fn create_profile(app: &TestApp, name: &str, favourite: PaletteKey) -> Profile {
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(&NewProfile {
            name: name.to_owned(),
            avatar: Avatar::BuiltIn {
                key: AvatarKey::Star,
            },
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

fn phone_mic(n: u32) -> Option<MicKey> {
    Some(MicKey::Phone {
        phone_id: phone_id(n).0,
    })
}

/// Joins Phone `n` as a new Profile `name`; returns its socket and member
/// id, past every message the join sent it. `stage` hears the join.
async fn joined_phone(
    app: &TestApp,
    stage: &mut WsClient,
    code: &JoinCode,
    n: u32,
    name: &str,
    favourite: PaletteKey,
) -> (WsClient, PartyMemberId) {
    let profile = create_profile(app, name, favourite).await;
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
        other => panic!("expected the Phone's status, got {other:?}"),
    };
    party_changed(&mut socket).await;
    party_changed(stage).await;
    (socket, member_id)
}

fn add(song_id: SongId, requested_players: Option<Vec<PartyMemberId>>) -> ClientMessage {
    ClientMessage::AddRequest {
        song_id,
        requested_players,
    }
}

fn seat(member_id: PartyMemberId, mic: Option<MicKey>, voice: SeatVoice) -> Seat {
    Seat {
        member_id,
        mic,
        voice,
        difficulty: Difficulty::Medium,
    }
}

#[tokio::test]
async fn a_request_reaching_the_head_gets_a_prefilled_line_up_that_waits() {
    let (app, solo, _) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let (mut bo, bo_id) = joined_phone(&app, &mut stage, &code, 1, "Bo", PaletteKey::Sky).await;

    bo.send(&add(solo, None)).await;
    let (party, _) = party_changed(&mut stage).await;
    let head = party.queue[0].request_id;
    assert_eq!(party.head, Some(head));
    assert_eq!(
        party.line_up,
        Some(LineUp {
            request_id: head,
            duet: false,
            seats: vec![seat(bo_id, phone_mic(1), SeatVoice::P1)],
            can_start: true,
            warnings: vec![],
        })
    );
    party_changed(&mut bo).await;

    // A second Request waits behind the head: the Line-up stays the head's,
    // and nothing starts by itself.
    stage.send(&add(solo, None)).await;
    let (party, _) = party_changed(&mut stage).await;
    assert_eq!(party.line_up.unwrap().request_id, head);
    heard_nothing(&mut stage).await;
}

#[tokio::test]
async fn a_duet_alternates_voices_and_a_stage_request_gives_an_empty_line_up() {
    let (app, solo, duet) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let (mut bo, bo_id) = joined_phone(&app, &mut stage, &code, 1, "Bo", PaletteKey::Sky).await;
    let (_ann, ann_id) = joined_phone(&app, &mut stage, &code, 2, "Ann", PaletteKey::Teal).await;
    party_changed(&mut bo).await;

    // The Stage's Request names nobody: an empty Line-up that cannot start.
    stage.send(&add(solo, None)).await;
    let (party, _) = party_changed(&mut stage).await;
    let empty = party.line_up.unwrap();
    assert_eq!(empty.seats, vec![]);
    assert!(!empty.can_start);

    bo.send(&add(duet, Some(vec![ann_id, bo_id]))).await;
    let (party, _) = party_changed(&mut stage).await;
    let first = party.queue[0].request_id;
    stage
        .send(&ClientMessage::RemoveRequest { request_id: first })
        .await;
    let (party, _) = party_changed(&mut stage).await;
    let line_up = party.line_up.unwrap();
    assert_eq!(line_up.request_id, party.queue[0].request_id);
    assert!(line_up.duet);
    assert_eq!(
        line_up.seats,
        vec![
            seat(ann_id, phone_mic(2), SeatVoice::P1),
            seat(bo_id, phone_mic(1), SeatVoice::P2),
        ]
    );
    assert!(line_up.can_start);

    // Removing the last waiting head brings up the song browser.
    stage
        .send(&ClientMessage::RemoveRequest {
            request_id: line_up.request_id,
        })
        .await;
    let (party, _) = party_changed(&mut stage).await;
    assert_eq!((party.head, party.line_up), (None, None));
}

#[tokio::test]
async fn a_seated_phone_reports_its_mic_blocked_and_open_again() {
    let (app, solo, _) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let (mut bo, bo_id) = joined_phone(&app, &mut stage, &code, 1, "Bo", PaletteKey::Sky).await;

    // Not seated yet: the report changes no Line-up, so nobody hears of it.
    bo.send(&ClientMessage::ReportMicBlocked { blocked: true })
        .await;
    heard_nothing(&mut stage).await;

    // Seated with the report standing: the warning shows, Start stays.
    bo.send(&add(solo, None)).await;
    let (party, _) = party_changed(&mut stage).await;
    let line_up = party.line_up.unwrap();
    assert_eq!(
        line_up.warnings,
        vec![LineUpWarning::MicBlocked { member_id: bo_id }]
    );
    assert!(line_up.can_start);
    party_changed(&mut bo).await;

    bo.send(&ClientMessage::ReportMicBlocked { blocked: false })
        .await;
    let (party, change) = party_changed(&mut stage).await;
    assert_eq!(
        change,
        ChangeEvent {
            actor: Actor::Member { member_id: bo_id },
            event: PartyEvent::MicOpened {
                member_id: bo_id,
                name: "Bo".into()
            },
        }
    );
    assert_eq!(party.line_up.unwrap().warnings, vec![]);
    party_changed(&mut bo).await;

    bo.send(&ClientMessage::ReportMicBlocked { blocked: true })
        .await;
    let (party, change) = party_changed(&mut stage).await;
    assert_eq!(
        change.event,
        PartyEvent::MicBlocked {
            member_id: bo_id,
            name: "Bo".into()
        }
    );
    assert_eq!(
        party.line_up.unwrap().warnings,
        vec![LineUpWarning::MicBlocked { member_id: bo_id }]
    );

    // The same report again changes nothing.
    party_changed(&mut bo).await;
    bo.send(&ClientMessage::ReportMicBlocked { blocked: true })
        .await;
    heard_nothing(&mut bo).await;
    heard_nothing(&mut stage).await;

    // A browser that has not joined may not report.
    let mut stranger = app.connect_ws().await;
    live_party(&mut stranger).await;
    stranger
        .send(&ClientMessage::ReportMicBlocked { blocked: true })
        .await;
    assert_eq!(
        recv(&mut stranger).await,
        ServerMessage::Rejected {
            reason: UserMessage::NotInParty
        }
    );
}

#[tokio::test]
async fn the_line_up_survives_a_restart_and_new_party_clears_it() {
    let (mut app, _, duet) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let (mut bo, bo_id) = joined_phone(&app, &mut stage, &code, 1, "Bo", PaletteKey::Sky).await;
    bo.send(&add(duet, None)).await;
    let (before, _) = party_changed(&mut stage).await;
    let line_up = before.line_up.clone().unwrap();
    assert_eq!(
        line_up.warnings,
        vec![LineUpWarning::DuetNeedsVoice {
            voice: SeatVoice::P2
        }]
    );
    assert_eq!(
        line_up.seats,
        vec![seat(bo_id, phone_mic(1), SeatVoice::P1)]
    );
    drop((stage, bo));

    app.restart().await;
    let mut stage = app.connect_stage().await;
    let after = live_party(&mut stage).await.unwrap();
    assert_eq!(after.line_up, before.line_up);

    stage.send(&ClientMessage::NewParty).await;
    let (party, _) = party_changed(&mut stage).await;
    assert_eq!((party.head, party.line_up), (None, None));
    drop(stage);

    app.restart().await;
    let mut stage = app.connect_stage().await;
    let party = live_party(&mut stage).await.unwrap();
    assert_eq!((party.head, party.line_up), (None, None));
}
