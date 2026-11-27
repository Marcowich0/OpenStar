//! Song progress reports (#159): the Stage reports its position and rate on
//! events only, and the server keeps the latest report and passes it to
//! every Remote, also to one that connects mid-Song.

use std::path::Path;
use std::time::Duration;

use openstar::clock::ManualClock;
use openstar_protocol::library::{SongId, SongList};
use openstar_protocol::profile::{Avatar, AvatarKey, PaletteKey};
use openstar_protocol::{
    ClientMessage, JoinAs, NewGuest, PartySnapshot, PhoneId, RequestId, ServerMessage, SongControl,
    SongProgress, UserMessage,
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

/// The next message on `socket`, past change notices for HTTP data.
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. } => {}
            message => return message,
        }
    }
}

async fn party_changed(socket: &mut WsClient) -> PartySnapshot {
    match recv(socket).await {
        ServerMessage::PartyChanged { party, .. } => party,
        other => panic!("expected a Party change, got {other:?}"),
    }
}

async fn progress(socket: &mut WsClient) -> SongProgress {
    match recv(socket).await {
        ServerMessage::SongProgress { progress } => progress,
        other => panic!("expected a progress report, got {other:?}"),
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

fn report(request_id: RequestId, position_seconds: f64, rate: f64) -> ClientMessage {
    ClientMessage::ReportSongPosition {
        request_id,
        position_seconds,
        rate,
        length_seconds: Some(180.0),
        intro_end_seconds: None,
    }
}

/// A report of a Song whose Skip intro lands at `intro_end_seconds`.
fn intro_report(
    request_id: RequestId,
    position_seconds: f64,
    rate: f64,
    intro_end_seconds: f64,
) -> ClientMessage {
    ClientMessage::ReportSongPosition {
        request_id,
        position_seconds,
        rate,
        length_seconds: Some(180.0),
        intro_end_seconds: Some(intro_end_seconds),
    }
}

fn expected(request_id: RequestId, position_seconds: f64, rate: f64, age_ms: u32) -> SongProgress {
    SongProgress {
        request_id,
        position_seconds,
        rate,
        length_seconds: Some(180.0),
        intro_end_seconds: None,
        age_ms,
    }
}

struct Playing {
    app: TestApp,
    clock: ManualClock,
    stage: WsClient,
    phone: WsClient,
    request: RequestId,
}

/// A Stage and a Guest's Phone, with the Guest's Request for "Solo"
/// started: the Stage has been told Start.
async fn playing() -> Playing {
    let clock = ManualClock::new();
    let mut app = TestApp::builder().clock(&clock).start().await;
    write_song(&app.songs_dir().join("Solo"), "Solo");
    app.restart().await;
    let songs = app.get_json::<SongList>("/api/songs").await.songs;
    let solo: SongId = songs[0].id;

    let mut stage = app.connect_stage().await;
    recv(&mut stage).await; // the live state
    let code = party_changed(&mut stage).await.join_code;

    let mut phone = app.connect_ws().await;
    recv(&mut phone).await;
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
    assert!(matches!(
        recv(&mut phone).await,
        ServerMessage::PhoneStatus { .. }
    ));
    party_changed(&mut phone).await;
    party_changed(&mut stage).await;

    phone
        .send(&ClientMessage::AddRequest {
            song_id: solo,
            requested_players: None,
        })
        .await;
    party_changed(&mut phone).await;
    let request = party_changed(&mut stage).await.line_up.unwrap().request_id;

    stage
        .send(&ClientMessage::ControlSong {
            request_id: request,
            control: SongControl::Start,
        })
        .await;
    party_changed(&mut phone).await;
    party_changed(&mut stage).await;
    assert!(matches!(
        recv(&mut stage).await,
        ServerMessage::ControlSong { .. }
    ));
    Playing {
        app,
        clock,
        stage,
        phone,
        request,
    }
}

#[tokio::test]
async fn each_stage_report_reaches_every_connection_once_and_nothing_else_does() {
    // The app runs as long as `_app` lives.
    let Playing {
        app: _app,
        mut stage,
        mut phone,
        request,
        ..
    } = playing().await;

    // Start, pause, resume, Restart and end: one report each, passed on as it is.
    for (position, rate) in [
        (0.0, 1.0),
        (12.5, 0.0),
        (12.5, 1.0),
        (0.0, 1.0),
        (61.0, 0.0),
    ] {
        stage.send(&report(request, position, rate)).await;
        let sent = expected(request, position, rate, 0);
        assert_eq!(progress(&mut phone).await, sent);
        assert_eq!(progress(&mut stage).await, sent);
    }
    // Between reports nothing reaches a Remote: no position stream.
    hears_nothing(&mut phone).await;
}

#[tokio::test]
async fn a_remote_that_connects_mid_song_is_told_the_latest_report_and_its_age() {
    let Playing {
        app,
        clock,
        mut stage,
        mut phone,
        request,
        ..
    } = playing().await;

    // Before any report a new connection is told none.
    let mut early = app.connect_ws().await;
    assert!(matches!(
        recv(&mut early).await,
        ServerMessage::LiveState { .. }
    ));
    hears_nothing(&mut early).await;

    stage.send(&report(request, 3.0, 1.0)).await;
    progress(&mut phone).await;
    stage.send(&report(request, 20.0, 0.0)).await;
    progress(&mut phone).await;
    clock.advance(Duration::from_millis(1500));

    let mut late = app.connect_ws().await;
    assert!(matches!(
        recv(&mut late).await,
        ServerMessage::LiveState { .. }
    ));
    assert_eq!(
        progress(&mut late).await,
        expected(request, 20.0, 0.0, 1500)
    );
    hears_nothing(&mut late).await;
}

#[tokio::test]
async fn a_report_whose_song_no_longer_plays_is_not_passed_to_new_connections() {
    let Playing {
        app,
        mut stage,
        mut phone,
        request,
        ..
    } = playing().await;
    stage.send(&report(request, 5.0, 1.0)).await;
    progress(&mut phone).await;
    progress(&mut stage).await;

    stage
        .send(&ClientMessage::ControlSong {
            request_id: request,
            control: SongControl::Skip,
        })
        .await;
    party_changed(&mut stage).await;

    let mut late = app.connect_ws().await;
    recv(&mut late).await;
    hears_nothing(&mut late).await;
}

#[tokio::test]
async fn only_the_active_stage_reports_and_only_for_the_playing_song() {
    let Playing {
        app: _app,
        mut stage,
        mut phone,
        request,
        ..
    } = playing().await;

    assert_eq!(
        refused(&mut phone, report(request, 1.0, 1.0)).await,
        UserMessage::NotTheStage
    );
    assert_eq!(
        refused(&mut stage, report(RequestId(999), 1.0, 1.0)).await,
        UserMessage::NoSongPlaying
    );
    for bad in [
        report(request, -1.0, 1.0),
        // Not finite: JSON sends it as `null`.
        report(request, f64::NAN, 1.0),
        report(request, 1.0, -1.0),
        ClientMessage::ReportSongPosition {
            request_id: request,
            position_seconds: 1.0,
            rate: 1.0,
            length_seconds: Some(-5.0),
            intro_end_seconds: None,
        },
        intro_report(request, 1.0, 1.0, -2.0),
    ] {
        assert_eq!(refused(&mut stage, bad).await, UserMessage::InvalidMessage);
    }
    hears_nothing(&mut phone).await;
}

#[tokio::test]
async fn skip_intro_is_passed_on_only_while_the_latest_report_has_the_song_in_its_intro() {
    let Playing {
        app: _app,
        clock,
        mut stage,
        mut phone,
        request,
    } = playing().await;
    let skip = ClientMessage::ControlSong {
        request_id: request,
        control: SongControl::SkipIntro,
    };
    async fn reported(stage: &mut WsClient, phone: &mut WsClient, message: ClientMessage) {
        stage.send(&message).await;
        progress(phone).await;
        progress(stage).await;
    }

    // No report yet, and a Song without an Intro: nothing to skip.
    assert_eq!(
        refused(&mut phone, skip.clone()).await,
        UserMessage::NoIntroToSkip
    );
    reported(&mut stage, &mut phone, report(request, 0.0, 1.0)).await;
    assert_eq!(
        refused(&mut phone, skip.clone()).await,
        UserMessage::NoIntroToSkip
    );

    // Playing its Intro, which Skip intro jumps to 27 s: everyone hears it,
    // then the Stage is told to act.
    reported(
        &mut stage,
        &mut phone,
        intro_report(request, 0.0, 1.0, 27.0),
    )
    .await;
    clock.advance(Duration::from_secs(20));
    phone.send(&skip).await;
    party_changed(&mut phone).await;
    party_changed(&mut stage).await;
    assert!(matches!(
        recv(&mut stage).await,
        ServerMessage::ControlSong {
            control: SongControl::SkipIntro,
            ..
        }
    ));

    // By the report's own reckoning the Intro is over 7 s later.
    clock.advance(Duration::from_secs(7));
    assert_eq!(
        refused(&mut phone, skip.clone()).await,
        UserMessage::NoIntroToSkip
    );

    // Not while it is paused.
    reported(
        &mut stage,
        &mut phone,
        intro_report(request, 5.0, 0.0, 27.0),
    )
    .await;
    assert_eq!(
        refused(&mut phone, skip.clone()).await,
        UserMessage::NoIntroToSkip
    );
    hears_nothing(&mut stage).await;
}
