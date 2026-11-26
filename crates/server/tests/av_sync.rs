//! Check A/V sync over the real app (#163): the Stage or any joined Remote
//! starts it with no Admin PIN, the server tells every connection while it
//! runs, a Remote's −/+ and Reset reach the Stage (which saves under its own
//! browser id), Done ends it, and starting it while a Song plays is refused.

use std::path::Path;

use openstar_protocol::av_offset::AvSyncStep;
use openstar_protocol::library::SongList;
use openstar_protocol::profile::{Avatar, AvatarKey, PaletteKey};
use openstar_protocol::{
    ClientMessage, JoinAs, JoinCode, NewGuest, PhoneId, ServerMessage, SongControl, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

fn write_song(folder: &Path, title: &str) {
    std::fs::create_dir_all(folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:Placeholder\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n"),
    )
    .unwrap();
}

/// The next message on `socket`, past change notices, Party changes and
/// volume reports.
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. }
            | ServerMessage::PartyChanged { .. }
            | ServerMessage::Volume { .. } => {}
            message => return message,
        }
    }
}

/// Nothing more was sent to `socket`: a Ping is answered next.
async fn hears_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 77 });
}

async fn refused(socket: &mut WsClient, message: ClientMessage) -> UserMessage {
    socket.send(&message).await;
    match recv(socket).await {
        ServerMessage::Rejected { reason } => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn running(running: bool) -> ServerMessage {
    ServerMessage::AvSync { running }
}

/// Opens the Stage, past its live state, and returns it with the Join code.
async fn open_stage(app: &TestApp) -> (WsClient, JoinCode) {
    let mut stage = app.connect_stage().await;
    let mut code = match stage.recv().await {
        ServerMessage::LiveState {
            is_stage: true,
            party,
            ..
        } => party.map(|party| party.join_code),
        other => panic!("expected the live state first, got {other:?}"),
    };
    if code.is_none() {
        match stage.recv().await {
            ServerMessage::PartyChanged { party, .. } => code = Some(party.join_code),
            other => panic!("expected the first Party, got {other:?}"),
        }
    }
    (stage, code.unwrap())
}

/// A Phone joined to the Party as a Guest, past its own status.
async fn joined_phone(app: &TestApp, code: &JoinCode) -> WsClient {
    let mut phone = app.connect_ws().await;
    assert!(matches!(
        recv(&mut phone).await,
        ServerMessage::LiveState { .. }
    ));
    phone
        .send(&ClientMessage::Join {
            phone_id: PhoneId("4b1d8f0e-0000-4000-8000-000000000001".into()),
            join_code: code.clone(),
            join_as: JoinAs::Guest(NewGuest {
                name: "Bo".into(),
                colour: PaletteKey::Sky,
                avatar: Avatar::BuiltIn {
                    key: AvatarKey::Star,
                },
            }),
        })
        .await;
    match recv(&mut phone).await {
        ServerMessage::PhoneStatus { member_id: Some(_) } => phone,
        other => panic!("expected the Phone's status, got {other:?}"),
    }
}

#[tokio::test]
async fn a_remote_starts_steps_and_ends_it_and_every_browser_hears_while_it_runs() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut phone = joined_phone(&app, &code).await;

    // A step before the check runs has nothing to act on.
    assert_eq!(
        refused(
            &mut phone,
            ClientMessage::StepAvSync {
                step: AvSyncStep::Up
            }
        )
        .await,
        UserMessage::AvSyncNotRunning
    );

    phone.send(&ClientMessage::StartAvSync).await;
    assert_eq!(recv(&mut phone).await, running(true));
    assert_eq!(recv(&mut stage).await, running(true));

    // A browser that connects now is told after its live state.
    let mut late = app.connect_ws().await;
    assert!(matches!(
        recv(&mut late).await,
        ServerMessage::LiveState { .. }
    ));
    assert_eq!(recv(&mut late).await, running(true));

    // The Remote's −, + and Reset reach the Stage alone, in order.
    for step in [AvSyncStep::Down, AvSyncStep::Up, AvSyncStep::Reset] {
        phone.send(&ClientMessage::StepAvSync { step }).await;
    }
    for step in [AvSyncStep::Down, AvSyncStep::Up, AvSyncStep::Reset] {
        assert_eq!(recv(&mut stage).await, ServerMessage::StepAvSync { step });
    }
    hears_nothing(&mut phone).await;
    hears_nothing(&mut late).await;

    // Done, from the Remote: every browser hears it has ended.
    phone.send(&ClientMessage::EndAvSync).await;
    assert_eq!(recv(&mut phone).await, running(false));
    assert_eq!(recv(&mut stage).await, running(false));
    assert_eq!(recv(&mut late).await, running(false));

    // Ending it again changes nothing.
    stage.send(&ClientMessage::EndAvSync).await;
    hears_nothing(&mut stage).await;
}

#[tokio::test]
async fn the_stage_starts_it_with_no_pin_and_a_stranger_cannot() {
    let app = TestApp::start().await;
    let (mut stage, _) = open_stage(&app).await;
    let mut stranger = app.connect_ws().await;
    recv(&mut stranger).await; // the live state

    assert_eq!(
        refused(&mut stranger, ClientMessage::StartAvSync).await,
        UserMessage::NotInParty
    );

    stage.send(&ClientMessage::StartAvSync).await;
    assert_eq!(recv(&mut stage).await, running(true));
    assert_eq!(recv(&mut stranger).await, running(true));
    // Starting it again while it runs changes nothing.
    stage.send(&ClientMessage::StartAvSync).await;
    hears_nothing(&mut stage).await;
}

#[tokio::test]
async fn it_ends_when_the_stage_closes() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut phone = joined_phone(&app, &code).await;
    stage.send(&ClientMessage::StartAvSync).await;
    assert_eq!(recv(&mut stage).await, running(true));
    assert_eq!(recv(&mut phone).await, running(true));

    drop(stage);
    assert_eq!(recv(&mut phone).await, running(false));
    // With no Stage it cannot start.
    assert_eq!(
        refused(&mut phone, ClientMessage::StartAvSync).await,
        UserMessage::NoStage
    );
}

#[tokio::test]
async fn it_is_refused_while_a_song_plays_and_ends_when_one_starts() {
    let mut app = TestApp::start().await;
    write_song(&app.songs_dir().join("Solo"), "Solo");
    app.restart().await;
    let solo = app.get_json::<SongList>("/api/songs").await.songs[0].id;
    let (mut stage, code) = open_stage(&app).await;
    let mut phone = joined_phone(&app, &code).await;

    phone
        .send(&ClientMessage::AddRequest {
            song_id: solo,
            requested_players: None,
        })
        .await;
    let request = loop {
        match stage.recv().await {
            ServerMessage::PartyChanged { party, .. } if party.line_up.is_some() => {
                break party.line_up.unwrap().request_id;
            }
            _ => {}
        }
    };
    // The check runs over the waiting Line-up.
    phone.send(&ClientMessage::StartAvSync).await;
    assert_eq!(recv(&mut phone).await, running(true));
    assert_eq!(recv(&mut stage).await, running(true));
    // Starting the Song ends the check.
    phone
        .send(&ClientMessage::ControlSong {
            request_id: request,
            control: SongControl::Start,
        })
        .await;
    assert_eq!(recv(&mut phone).await, running(false));
    loop {
        match recv(&mut stage).await {
            ServerMessage::ControlSong { .. } => {}
            message => {
                assert_eq!(message, running(false));
                break;
            }
        }
    }

    assert_eq!(
        refused(&mut phone, ClientMessage::StartAvSync).await,
        UserMessage::NotWhileSongPlays
    );
    assert_eq!(
        refused(&mut stage, ClientMessage::StartAvSync).await,
        UserMessage::NotWhileSongPlays
    );
}
