//! The Pitch reading relay over real WebSockets: a Phone's readings and
//! clock pings reach the current Stage, the Stage's pongs go back to the
//! Phone that pinged, nothing is queued while there is no Stage, a closed
//! Phone is reported to the Stage, and no reading touches SQLite.

use futures_util::StreamExt;
use openstar_protocol::{ClientMessage, MicId, PitchReading, ServerMessage, UserMessage};
use openstar_test_harness::{TestApp, WsClient};

/// Closes a browser's WebSocket and waits until the server has closed its
/// end, by which time the server has handled the close.
async fn close(socket: WsClient) {
    let mut socket = socket.into_socket();
    socket.close(None).await.unwrap();
    while socket.next().await.is_some_and(|frame| frame.is_ok()) {}
}

/// Reads the live state (and, on a Stage, the Party it may start).
async fn skip_greeting(socket: &mut WsClient) {
    assert!(matches!(
        socket.recv().await,
        ServerMessage::LiveState { .. }
    ));
}

/// Asserts that nothing arrived on `socket` before the answer to a ping.
async fn heard_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(socket.recv().await, ServerMessage::Pong { nonce: 77 });
}

/// The Stage on a fresh server, after its greeting and the Party it started.
async fn open_stage(app: &TestApp) -> WsClient {
    let mut stage = app.connect_stage().await;
    skip_greeting(&mut stage).await;
    assert!(matches!(
        stage.recv().await,
        ServerMessage::PartyChanged { .. }
    ));
    stage
}

async fn open_phone(app: &TestApp) -> WsClient {
    let mut phone = app.connect_ws().await;
    skip_greeting(&mut phone).await;
    phone
}

async fn reading_at_stage(stage: &mut WsClient) -> (MicId, PitchReading) {
    match stage.recv().await {
        ServerMessage::PitchReading { mic, reading } => (mic, reading),
        other => panic!("expected a Pitch reading, got {other:?}"),
    }
}

async fn ping_at_stage(stage: &mut WsClient) -> (MicId, f64) {
    match stage.recv().await {
        ServerMessage::ClockPing { mic, t0 } => (mic, t0),
        other => panic!("expected a clock ping, got {other:?}"),
    }
}

fn reading(capture_ms: f64) -> PitchReading {
    PitchReading {
        capture_ms,
        pitch: Some(69.25),
        clarity: 0.93,
        loudness: -24.5,
    }
}

#[tokio::test]
async fn a_phones_readings_reach_the_stage_one_by_one_with_their_values_unchanged() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut phone = open_phone(&app).await;
    let mut bystander = open_phone(&app).await;

    // Sent as raw JSON, with values a lossy float parse or a re-rounding
    // would change, and an unvoiced reading with no pitch.
    phone
        .send_text(
            r#"{"type":"pitchReading","reading":{"captureMs":123456.78901234567,"pitch":60.123456789012345,"clarity":0.30000000000000004,"loudness":-120}}"#,
        )
        .await;
    phone
        .send_text(
            r#"{"type":"pitchReading","reading":{"captureMs":123466.78901234567,"pitch":null,"clarity":0.1,"loudness":-43.21}}"#,
        )
        .await;

    let (mic, first) = reading_at_stage(&mut stage).await;
    assert_eq!(
        first,
        PitchReading {
            capture_ms: 123456.78901234567,
            pitch: Some(60.123456789012345),
            clarity: 0.30000000000000004,
            loudness: -120.0,
        }
    );
    let (same_mic, second) = reading_at_stage(&mut stage).await;
    assert_eq!(same_mic, mic, "every reading names the Mic it came from");
    assert_eq!(
        second,
        PitchReading {
            capture_ms: 123466.78901234567,
            pitch: None,
            clarity: 0.1,
            loudness: -43.21,
        }
    );
    heard_nothing(&mut stage).await;
    // Readings go to the Stage only.
    heard_nothing(&mut bystander).await;
    heard_nothing(&mut phone).await;
}

#[tokio::test]
async fn readings_from_two_phones_name_different_mics() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut alice = open_phone(&app).await;
    let mut bob = open_phone(&app).await;

    alice
        .send(&ClientMessage::PitchReading {
            reading: reading(1.0),
        })
        .await;
    let (alice_mic, _) = reading_at_stage(&mut stage).await;
    bob.send(&ClientMessage::PitchReading {
        reading: reading(2.0),
    })
    .await;
    let (bob_mic, _) = reading_at_stage(&mut stage).await;
    alice
        .send(&ClientMessage::PitchReading {
            reading: reading(3.0),
        })
        .await;
    let (again, third) = reading_at_stage(&mut stage).await;

    assert_ne!(alice_mic, bob_mic);
    assert_eq!((again, third), (alice_mic, reading(3.0)));
}

#[tokio::test]
async fn a_ping_reaches_the_stage_and_its_pong_goes_back_to_the_phone_that_pinged_alone() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut phone = open_phone(&app).await;
    let mut other_phone = open_phone(&app).await;

    phone
        .send(&ClientMessage::PitchReading {
            reading: reading(10.0),
        })
        .await;
    let (reading_mic, _) = reading_at_stage(&mut stage).await;

    phone.send(&ClientMessage::ClockPing { t0: 5012.375 }).await;
    let (mic, t0) = ping_at_stage(&mut stage).await;
    assert_eq!(
        (mic, t0),
        (reading_mic, 5012.375),
        "the ping names the same Mic as the Phone's readings"
    );

    stage
        .send(&ClientMessage::ClockPong {
            mic,
            t0,
            ts: 88123.456,
            epoch: 1_764_000_000_123.25,
        })
        .await;
    assert_eq!(
        phone.recv().await,
        ServerMessage::ClockPong {
            t0: 5012.375,
            ts: 88123.456,
            epoch: 1_764_000_000_123.25,
        }
    );
    heard_nothing(&mut other_phone).await;
    heard_nothing(&mut stage).await;
    heard_nothing(&mut phone).await;
}

#[tokio::test]
async fn only_the_active_stage_may_answer_a_ping() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut phone = open_phone(&app).await;
    let mut impostor = open_phone(&app).await;

    phone.send(&ClientMessage::ClockPing { t0: 1.0 }).await;
    let (mic, _) = ping_at_stage(&mut stage).await;
    impostor
        .send(&ClientMessage::ClockPong {
            mic,
            t0: 1.0,
            ts: 2.0,
            epoch: 3.0,
        })
        .await;

    assert_eq!(
        impostor.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::NotTheStage
        }
    );
    heard_nothing(&mut phone).await;
}

#[tokio::test]
async fn a_pong_for_a_phone_that_has_gone_is_dropped() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut phone = open_phone(&app).await;
    phone.send(&ClientMessage::ClockPing { t0: 1.0 }).await;
    let (mic, _) = ping_at_stage(&mut stage).await;
    drop(phone);
    assert_eq!(stage.recv().await, ServerMessage::MicClosed { mic });

    stage
        .send(&ClientMessage::ClockPong {
            mic,
            t0: 1.0,
            ts: 2.0,
            epoch: 3.0,
        })
        .await;
    heard_nothing(&mut stage).await;
}

#[tokio::test]
async fn readings_and_pings_are_dropped_not_queued_while_there_is_no_stage() {
    let app = TestApp::start().await;
    let mut phone = open_phone(&app).await;

    // Before any Stage has opened.
    phone
        .send(&ClientMessage::PitchReading {
            reading: reading(1.0),
        })
        .await;
    phone.send(&ClientMessage::ClockPing { t0: 1.0 }).await;
    heard_nothing(&mut phone).await;

    // After the Stage closed.
    let stage = open_stage(&app).await;
    assert!(matches!(
        phone.recv().await,
        ServerMessage::PartyChanged { .. }
    ));
    close(stage).await;
    phone
        .send(&ClientMessage::PitchReading {
            reading: reading(2.0),
        })
        .await;
    phone.send(&ClientMessage::ClockPing { t0: 2.0 }).await;
    heard_nothing(&mut phone).await;

    // A Stage that opens afterwards hears none of them, only what comes next.
    let mut stage = app.connect_stage().await;
    skip_greeting(&mut stage).await;
    heard_nothing(&mut stage).await;
    phone
        .send(&ClientMessage::PitchReading {
            reading: reading(3.0),
        })
        .await;
    assert_eq!(reading_at_stage(&mut stage).await.1, reading(3.0));
}

#[tokio::test]
async fn when_a_phones_websocket_closes_the_stage_is_told_which_mic_closed() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut alice = open_phone(&app).await;
    let mut bob = open_phone(&app).await;
    for phone in [&mut alice, &mut bob] {
        phone
            .send(&ClientMessage::PitchReading {
                reading: reading(1.0),
            })
            .await;
    }
    let (alice_mic, _) = reading_at_stage(&mut stage).await;
    let (bob_mic, _) = reading_at_stage(&mut stage).await;

    close(alice).await;
    assert_eq!(
        stage.recv().await,
        ServerMessage::MicClosed { mic: alice_mic }
    );
    drop(bob);
    assert_eq!(
        stage.recv().await,
        ServerMessage::MicClosed { mic: bob_mic }
    );
    heard_nothing(&mut stage).await;
}

#[tokio::test]
async fn a_browser_that_never_acted_as_a_mic_closes_without_a_mic_closed_notice() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let admin = open_phone(&app).await;
    close(admin).await;
    heard_nothing(&mut stage).await;
}

#[tokio::test]
async fn relaying_readings_writes_nothing_to_sqlite() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut phone = open_phone(&app).await;

    let db = rusqlite::Connection::open(app.appdata_dir().join(openstar::db::DATABASE_FILE))
        .expect("the app's database opens");
    let data_version = || -> i64 {
        db.query_row("PRAGMA data_version", [], |row| row.get(0))
            .unwrap()
    };
    let before = data_version();

    for i in 0..200 {
        phone
            .send(&ClientMessage::PitchReading {
                reading: reading(f64::from(i) * 10.0),
            })
            .await;
    }
    phone.send(&ClientMessage::ClockPing { t0: 1.0 }).await;
    for _ in 0..200 {
        reading_at_stage(&mut stage).await;
    }
    let (mic, _) = ping_at_stage(&mut stage).await;
    stage
        .send(&ClientMessage::ClockPong {
            mic,
            t0: 1.0,
            ts: 2.0,
            epoch: 3.0,
        })
        .await;
    assert!(matches!(
        phone.recv().await,
        ServerMessage::ClockPong { .. }
    ));
    drop(phone);
    assert_eq!(stage.recv().await, ServerMessage::MicClosed { mic });

    // `data_version` changes whenever another connection commits a write.
    assert_eq!(data_version(), before, "the relay wrote to SQLite");
}
