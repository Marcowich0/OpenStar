//! Mic bridge levels, over the real app: the server tells each open bridge
//! whether the Stage's Mics screen is open (and again whenever that
//! changes), and relays the levels an open bridge sends to the Stage under
//! its Local mic ids.

use futures_util::StreamExt;
use openstar_protocol::bridge::{
    BridgeId, BridgeInterface, BridgeLevel, LocalMicLevel, bridge_local_mic_id,
};
use openstar_protocol::{ClientMessage, ServerMessage, UserMessage};
use openstar_test_harness::{TestApp, WsClient};

const WAV: &str = "multichannel.wav";

fn hello() -> ClientMessage {
    ClientMessage::BridgeHello {
        build: openstar::BUILD_ID.into(),
        host_name: "hermes".into(),
        token: None,
        interfaces: vec![BridgeInterface {
            device_name: WAV.into(),
            label: WAV.into(),
            channels: 4,
            usb_id: None,
            twin: false,
        }],
    }
}

/// Closes a WebSocket and waits until the server has closed its end.
async fn close(socket: WsClient) {
    let mut socket = socket.into_socket();
    socket.close(None).await.unwrap();
    while socket.next().await.is_some_and(|frame| frame.is_ok()) {}
}

/// Opens the Stage, past its live state and (on a fresh server) the Party
/// it started.
async fn open_stage(app: &TestApp, fresh: bool) -> WsClient {
    let mut stage = app.connect_stage().await;
    assert!(matches!(
        stage.recv().await,
        ServerMessage::LiveState { is_stage: true, .. }
    ));
    if fresh {
        assert!(matches!(
            stage.recv().await,
            ServerMessage::PartyChanged { .. }
        ));
    }
    stage
}

/// The next message on `socket` past the change notices every socket gets.
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. } | ServerMessage::PartyChanged { .. } => {}
            message => return message,
        }
    }
}

/// Asserts that nothing but change notices arrived before a ping's answer.
async fn heard_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 77 });
}

/// A bridge socket that said hello and waits for approval.
async fn waiting_bridge(app: &TestApp) -> WsClient {
    let mut bridge = app.connect_ws_at("/ws/bridge").await;
    assert!(matches!(
        bridge.recv().await,
        ServerMessage::LiveState { .. }
    ));
    bridge.send(&hello()).await;
    assert!(matches!(
        recv(&mut bridge).await,
        ServerMessage::BridgeWaiting { .. }
    ));
    bridge
}

/// Approves the one waiting bridge; returns its id, with the bridge past
/// its token, `BridgeConnected` and `BridgeChannels`.
async fn approve(app: &TestApp, stage: &mut WsClient, bridge: &mut WsClient) -> BridgeId {
    let listing: openstar_protocol::bridge::MicBridges = app.get_json("/api/mic-bridges").await;
    stage
        .send(&ClientMessage::ApproveBridge {
            request_id: listing.requests[0].request_id,
        })
        .await;
    assert!(matches!(
        recv(bridge).await,
        ServerMessage::BridgeApproved { .. }
    ));
    let ServerMessage::BridgeConnected { bridge_id } = recv(bridge).await else {
        panic!("expected BridgeConnected");
    };
    assert!(matches!(
        recv(bridge).await,
        ServerMessage::BridgeChannels { .. }
    ));
    bridge_id
}

async fn expect_mics_screen(bridge: &mut WsClient, open: bool) {
    assert_eq!(recv(bridge).await, ServerMessage::BridgeMicsScreen { open });
}

fn level(channel: u32, level_dbfs: f64) -> BridgeLevel {
    BridgeLevel {
        device_name: WAV.into(),
        channel,
        level_dbfs,
        digital_silence: false,
    }
}

#[tokio::test]
async fn a_bridge_is_told_whether_the_mics_screen_is_open_and_again_when_it_changes() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app, true).await;
    let mut bridge = waiting_bridge(&app).await;
    approve(&app, &mut stage, &mut bridge).await;
    expect_mics_screen(&mut bridge, false).await;

    stage
        .send(&ClientMessage::SetMicsScreenOpen { open: true })
        .await;
    expect_mics_screen(&mut bridge, true).await;
    // Saying it again changes nothing, so the bridge is not told again.
    stage
        .send(&ClientMessage::SetMicsScreenOpen { open: true })
        .await;
    heard_nothing(&mut stage).await;
    stage
        .send(&ClientMessage::SetMicsScreenOpen { open: false })
        .await;
    expect_mics_screen(&mut bridge, false).await;
}

#[tokio::test]
async fn a_bridge_that_connects_while_the_mics_screen_is_open_is_told_so() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app, true).await;
    stage
        .send(&ClientMessage::SetMicsScreenOpen { open: true })
        .await;
    heard_nothing(&mut stage).await;
    let mut bridge = waiting_bridge(&app).await;
    approve(&app, &mut stage, &mut bridge).await;
    expect_mics_screen(&mut bridge, true).await;
}

#[tokio::test]
async fn the_mics_screen_counts_as_closed_once_its_stage_closes_or_moves() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app, true).await;
    let mut bridge = waiting_bridge(&app).await;
    approve(&app, &mut stage, &mut bridge).await;
    expect_mics_screen(&mut bridge, false).await;

    stage
        .send(&ClientMessage::SetMicsScreenOpen { open: true })
        .await;
    expect_mics_screen(&mut bridge, true).await;
    close(stage).await;
    expect_mics_screen(&mut bridge, false).await;

    let mut stage = open_stage(&app, false).await;
    stage
        .send(&ClientMessage::SetMicsScreenOpen { open: true })
        .await;
    expect_mics_screen(&mut bridge, true).await;
    let _other = open_stage(&app, false).await;
    expect_mics_screen(&mut bridge, false).await;
}

#[tokio::test]
async fn only_the_stage_may_say_the_mics_screen_opened() {
    let app = TestApp::start().await;
    let _stage = open_stage(&app, true).await;
    let mut phone = app.connect_ws().await;
    assert!(matches!(
        phone.recv().await,
        ServerMessage::LiveState { .. }
    ));
    phone
        .send(&ClientMessage::SetMicsScreenOpen { open: true })
        .await;
    assert_eq!(
        recv(&mut phone).await,
        ServerMessage::Rejected {
            reason: UserMessage::NotTheStage
        }
    );
}

#[tokio::test]
async fn levels_from_an_open_bridge_reach_the_stage_under_its_local_mic_ids() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app, true).await;
    let mut bridge = waiting_bridge(&app).await;
    let bridge_id = approve(&app, &mut stage, &mut bridge).await;

    bridge
        .send(&ClientMessage::BridgeLevels {
            // Channel 9 is not one the bridge offers: it is dropped.
            // Channel 3 sends exact zeros: the Stage is told so.
            levels: vec![
                level(0, -12.5),
                level(9, -3.0),
                BridgeLevel {
                    digital_silence: true,
                    ..level(3, -100.0)
                },
            ],
        })
        .await;
    assert_eq!(
        recv(&mut stage).await,
        ServerMessage::LocalMicLevels {
            levels: vec![
                LocalMicLevel {
                    local_mic_id: bridge_local_mic_id(&bridge_id, WAV, 0),
                    level_dbfs: -12.5,
                    digital_silence: false,
                },
                LocalMicLevel {
                    local_mic_id: bridge_local_mic_id(&bridge_id, WAV, 3),
                    level_dbfs: -100.0,
                    digital_silence: true,
                },
            ]
        }
    );
}

#[tokio::test]
async fn levels_from_a_waiting_bridge_or_a_browser_are_dropped() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app, true).await;
    let mut bridge = waiting_bridge(&app).await;
    bridge
        .send(&ClientMessage::BridgeLevels {
            levels: vec![level(0, -12.5)],
        })
        .await;
    let mut phone = app.connect_ws().await;
    assert!(matches!(
        phone.recv().await,
        ServerMessage::LiveState { .. }
    ));
    phone
        .send(&ClientMessage::BridgeLevels {
            levels: vec![level(0, -12.5)],
        })
        .await;
    heard_nothing(&mut bridge).await;
    heard_nothing(&mut phone).await;
    heard_nothing(&mut stage).await;
}
