//! A Mic bridge of another build (newer or older) is told the server's
//! build and nothing else: it is not connected and does not wait for
//! approval, so it updates itself first (#209). There is no protocol
//! version: only an exact match connects.

use openstar_protocol::bridge::{BridgeInterface, MicBridges};
use openstar_protocol::{ClientMessage, ServerMessage};
use openstar_test_harness::{TestApp, WsClient};

fn hello(build: &str) -> ClientMessage {
    ClientMessage::BridgeHello {
        build: build.into(),
        host_name: "hermes".into(),
        token: None,
        interfaces: vec![BridgeInterface {
            device_name: "multichannel.wav".into(),
            label: "multichannel.wav".into(),
            channels: 4,
            usb_id: None,
            twin: false,
        }],
    }
}

async fn connect_bridge(app: &TestApp) -> WsClient {
    let mut bridge = app.connect_ws_at("/ws/bridge").await;
    assert!(matches!(
        bridge.recv().await,
        ServerMessage::LiveState {
            is_stage: false,
            ..
        }
    ));
    bridge
}

#[tokio::test]
async fn a_bridge_of_another_build_is_told_the_servers_build_and_not_let_in() {
    let app = TestApp::start().await;
    for other in ["1.3.2", "99.0.0", "edge-abcdef0"] {
        let mut bridge = connect_bridge(&app).await;
        bridge.send(&hello(other)).await;
        assert_eq!(
            bridge.recv().await,
            ServerMessage::BridgeUpdate {
                build: openstar::BUILD_ID.into()
            }
        );
        let listed: MicBridges = app.get_json("/api/mic-bridges").await;
        assert!(listed.requests.is_empty(), "{other} waits: {listed:?}");
        assert!(listed.bridges.is_empty());
    }
}

#[tokio::test]
async fn a_bridge_of_the_same_build_waits_for_approval() {
    let app = TestApp::start().await;
    let mut bridge = connect_bridge(&app).await;
    bridge.send(&hello(openstar::BUILD_ID)).await;
    assert!(matches!(
        bridge.recv().await,
        ServerMessage::BridgeWaiting { .. }
    ));
}
