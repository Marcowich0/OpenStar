//! Pitch readings from a Mic bridge over the real app: an approved bridge's
//! readings and clock pings reach the Stage like a Phone's, each tagged with
//! the bridge and the Local mic it came from, and the Stage's pongs go back
//! to that bridge for that Local mic; an unapproved bridge's readings never
//! reach the Stage; a closed bridge is reported as Mic-closed for each of
//! its Local mics. A test client stands in for the bridge.

use futures_util::StreamExt;
use openstar_protocol::bridge::{BridgeId, BridgeInterface, bridge_local_mic_id};
use openstar_protocol::{BridgeInput, ClientMessage, MicId, PitchReading, ServerMessage};
use openstar_test_harness::{TestApp, WsClient};

const WAV: &str = "multichannel.wav";
const CHANNELS: u32 = 4;

fn hello(token: Option<String>) -> ClientMessage {
    ClientMessage::BridgeHello {
        build: openstar::BUILD_ID.into(),
        host_name: "hermes".into(),
        token,
        interfaces: vec![BridgeInterface {
            device_name: WAV.into(),
            label: WAV.into(),
            channels: CHANNELS,
            usb_id: None,
            twin: false,
        }],
    }
}

fn input(channel: u32) -> BridgeInput {
    BridgeInput {
        device_name: WAV.into(),
        channel,
    }
}

fn mic(bridge_id: &BridgeId, channel: u32) -> MicId {
    MicId::Bridge {
        bridge_id: bridge_id.clone(),
        local_mic_id: bridge_local_mic_id(bridge_id, WAV, channel),
    }
}

/// A reading with values no serialiser would round by accident.
fn reading(capture_ms: f64) -> PitchReading {
    PitchReading {
        capture_ms,
        pitch: Some(57.123_456_789_012_34),
        clarity: 0.912_345_678_901_234_5,
        loudness: -23.456_789_012_345_67,
    }
}

fn bridge_reading(channel: u32, capture_ms: f64) -> ClientMessage {
    ClientMessage::PitchReading {
        reading: reading(capture_ms),
        input: Some(input(channel)),
    }
}

/// Closes a WebSocket and waits until the server has closed its end.
async fn close(socket: WsClient) {
    let mut socket = socket.into_socket();
    socket.close(None).await.unwrap();
    while socket.next().await.is_some_and(|frame| frame.is_ok()) {}
}

/// The next message on `socket` past the change notices every socket gets
/// and the bridge's own Mics-screen notice.
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. }
            | ServerMessage::PartyChanged { .. }
            | ServerMessage::BridgeMicsScreen { .. } => {}
            message => return message,
        }
    }
}

/// Asserts that nothing but change notices arrived before a ping's answer.
async fn heard_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 77 });
}

async fn open_stage(app: &TestApp) -> WsClient {
    let mut stage = app.connect_stage().await;
    assert!(matches!(
        stage.recv().await,
        ServerMessage::LiveState { is_stage: true, .. }
    ));
    assert!(matches!(
        stage.recv().await,
        ServerMessage::PartyChanged { .. }
    ));
    stage
}

/// A bridge socket that said hello with `token` and got its first answer.
async fn bridge_socket(app: &TestApp, token: Option<String>) -> (WsClient, ServerMessage) {
    let mut bridge = app.connect_ws_at("/ws/bridge").await;
    assert!(matches!(
        bridge.recv().await,
        ServerMessage::LiveState { .. }
    ));
    bridge.send(&hello(token)).await;
    let answer = recv(&mut bridge).await;
    (bridge, answer)
}

/// A bridge that waits for approval.
async fn waiting_bridge(app: &TestApp) -> WsClient {
    let (bridge, answer) = bridge_socket(app, None).await;
    assert!(matches!(answer, ServerMessage::BridgeWaiting { .. }));
    bridge
}

/// An approved, connected bridge: its socket, id and token.
async fn approved_bridge(app: &TestApp, stage: &mut WsClient) -> (WsClient, BridgeId, String) {
    let mut bridge = waiting_bridge(app).await;
    let listing: openstar_protocol::bridge::MicBridges = app.get_json("/api/mic-bridges").await;
    stage
        .send(&ClientMessage::ApproveBridge {
            request_id: listing.requests[0].request_id,
        })
        .await;
    let ServerMessage::BridgeApproved { token } = recv(&mut bridge).await else {
        panic!("expected BridgeApproved");
    };
    let ServerMessage::BridgeConnected { bridge_id } = recv(&mut bridge).await else {
        panic!("expected BridgeConnected");
    };
    assert!(matches!(
        recv(&mut bridge).await,
        ServerMessage::BridgeChannels { .. }
    ));
    (bridge, bridge_id, token)
}

#[tokio::test]
async fn an_approved_bridges_readings_reach_the_stage_unchanged_tagged_with_their_local_mic() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (mut bridge, bridge_id, _) = approved_bridge(&app, &mut stage).await;

    bridge.send(&bridge_reading(2, 1000.25)).await;
    bridge.send(&bridge_reading(0, 1010.5)).await;
    assert_eq!(
        recv(&mut stage).await,
        ServerMessage::PitchReading {
            mic: mic(&bridge_id, 2),
            reading: reading(1000.25),
        }
    );
    assert_eq!(
        recv(&mut stage).await,
        ServerMessage::PitchReading {
            mic: mic(&bridge_id, 0),
            reading: reading(1010.5),
        }
    );
}

#[tokio::test]
async fn a_bridges_ping_reaches_the_stage_and_the_pong_goes_back_to_that_bridge_for_that_local_mic()
{
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (mut bridge, bridge_id, _) = approved_bridge(&app, &mut stage).await;

    bridge
        .send(&ClientMessage::ClockPing {
            t0: 12.5,
            input: Some(input(3)),
        })
        .await;
    assert_eq!(
        recv(&mut stage).await,
        ServerMessage::ClockPing {
            mic: mic(&bridge_id, 3),
            t0: 12.5,
        }
    );
    stage
        .send(&ClientMessage::ClockPong {
            mic: mic(&bridge_id, 3),
            t0: 12.5,
            ts: 98_765.125,
            epoch: 1.7e12,
        })
        .await;
    assert_eq!(
        recv(&mut bridge).await,
        ServerMessage::ClockPong {
            t0: 12.5,
            ts: 98_765.125,
            epoch: 1.7e12,
            input: Some(input(3)),
        }
    );
    heard_nothing(&mut stage).await;
}

#[tokio::test]
async fn readings_and_pings_for_a_channel_the_bridge_does_not_offer_are_dropped() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (mut bridge, _, _) = approved_bridge(&app, &mut stage).await;

    bridge.send(&bridge_reading(CHANNELS, 1.0)).await;
    bridge
        .send(&ClientMessage::PitchReading {
            reading: reading(2.0),
            input: Some(BridgeInput {
                device_name: "another.wav".into(),
                channel: 0,
            }),
        })
        .await;
    // A bridge is several Mics: a reading must say which.
    bridge
        .send(&ClientMessage::PitchReading {
            reading: reading(3.0),
            input: None,
        })
        .await;
    bridge
        .send(&ClientMessage::ClockPing {
            t0: 1.0,
            input: None,
        })
        .await;
    heard_nothing(&mut bridge).await;
    heard_nothing(&mut stage).await;
}

#[tokio::test]
async fn readings_from_a_bridge_without_a_valid_approval_token_never_reach_the_stage() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;

    // Waiting for approval: no token yet.
    let mut waiting = waiting_bridge(&app).await;
    waiting.send(&bridge_reading(0, 1.0)).await;
    waiting
        .send(&ClientMessage::ClockPing {
            t0: 1.0,
            input: Some(input(0)),
        })
        .await;
    heard_nothing(&mut waiting).await;

    // A token nobody approved: it waits like a new bridge.
    let (mut forged, answer) = bridge_socket(&app, Some("not-a-token".into())).await;
    assert!(matches!(answer, ServerMessage::BridgeWaiting { .. }));
    forged.send(&bridge_reading(0, 2.0)).await;
    heard_nothing(&mut forged).await;

    // A bridge socket that never said hello.
    let mut silent = app.connect_ws_at("/ws/bridge").await;
    assert!(matches!(
        silent.recv().await,
        ServerMessage::LiveState { .. }
    ));
    silent.send(&bridge_reading(0, 3.0)).await;
    heard_nothing(&mut silent).await;

    // A browser naming a bridge input.
    let mut browser = app.connect_ws().await;
    assert!(matches!(
        browser.recv().await,
        ServerMessage::LiveState { .. }
    ));
    browser.send(&bridge_reading(0, 4.0)).await;
    heard_nothing(&mut browser).await;

    heard_nothing(&mut stage).await;
}

#[tokio::test]
async fn when_an_approved_bridge_closes_the_stage_is_told_each_of_its_local_mics_closed() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (bridge, bridge_id, _) = approved_bridge(&app, &mut stage).await;

    close(bridge).await;
    for channel in 0..CHANNELS {
        assert_eq!(
            recv(&mut stage).await,
            ServerMessage::MicClosed {
                mic: mic(&bridge_id, channel),
            }
        );
    }
    heard_nothing(&mut stage).await;
}

#[tokio::test]
async fn a_waiting_bridge_that_closes_sends_no_mic_closed() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    close(waiting_bridge(&app).await).await;
    heard_nothing(&mut stage).await;
}

#[tokio::test]
async fn a_bridge_that_connects_again_is_the_same_mics_and_its_old_connection_closes_quietly() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (old, bridge_id, token) = approved_bridge(&app, &mut stage).await;

    let (mut new, answer) = bridge_socket(&app, Some(token)).await;
    assert_eq!(
        answer,
        ServerMessage::BridgeConnected {
            bridge_id: bridge_id.clone()
        }
    );
    assert!(matches!(
        recv(&mut new).await,
        ServerMessage::BridgeChannels { .. }
    ));
    // The server closed the old connection itself: no Mic closed for that.
    drop(old);
    heard_nothing(&mut stage).await;

    new.send(&bridge_reading(1, 5.0)).await;
    assert_eq!(
        recv(&mut stage).await,
        ServerMessage::PitchReading {
            mic: mic(&bridge_id, 1),
            reading: reading(5.0),
        }
    );
    stage
        .send(&ClientMessage::ClockPong {
            mic: mic(&bridge_id, 1),
            t0: 1.0,
            ts: 2.0,
            epoch: 3.0,
        })
        .await;
    assert_eq!(
        recv(&mut new).await,
        ServerMessage::ClockPong {
            t0: 1.0,
            ts: 2.0,
            epoch: 3.0,
            input: Some(input(1)),
        }
    );
}

#[tokio::test]
async fn a_pong_for_a_bridge_that_is_closed_is_dropped() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (bridge, bridge_id, _) = approved_bridge(&app, &mut stage).await;
    close(bridge).await;
    for _ in 0..CHANNELS {
        assert!(matches!(
            recv(&mut stage).await,
            ServerMessage::MicClosed { .. }
        ));
    }
    stage
        .send(&ClientMessage::ClockPong {
            mic: mic(&bridge_id, 0),
            t0: 1.0,
            ts: 2.0,
            epoch: 3.0,
        })
        .await;
    heard_nothing(&mut stage).await;
}
