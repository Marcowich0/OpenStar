//! The Pro Audio profile message and Switch to Pro Audio (#206), over the
//! real app: what a bridge says it sees is listed in `GET /api/mic-bridges`
//! (its interfaces not in Pro Audio included) and replaced whenever it says
//! it again; Switch to Pro Audio on the Stage reaches that bridge; after a
//! switch its interface comes back with its channels' existing Local mic ids.

use openstar_protocol::bridge::{
    BridgeId, BridgeInterface, MicBridges, NotProAudio, bridge_local_mic_id,
};
use openstar_protocol::mics::LocalMicSource;
use openstar_protocol::{ChangeTopic, ClientMessage, ServerMessage, UserMessage};
use openstar_test_harness::{TestApp, WsClient};

const CARD: &str = "alsa_card.usb-Focusrite_Scarlett_4i4_4th_Gen_S46-00";

fn scarlett() -> BridgeInterface {
    BridgeInterface {
        device_name: CARD.into(),
        label: "Scarlett 4i4".into(),
        channels: 4,
        usb_id: Some("1235:821a".into()),
        twin: false,
    }
}

fn in_surround(switch_refused: bool) -> NotProAudio {
    NotProAudio {
        device_name: CARD.into(),
        card_name: CARD.into(),
        label: "Scarlett 4i4".into(),
        profile: "Analog Surround 2.1".into(),
        switch_refused,
    }
}

/// What the bridge sees while its Scarlett is in Analog Surround 2.1.
fn sees_surround(switch_refused: bool) -> ClientMessage {
    ClientMessage::BridgeInterfaces {
        interfaces: vec![],
        not_pro_audio: vec![in_surround(switch_refused)],
    }
}

/// Opens the Stage, past its live state and the Party it started.
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

/// The next message on `socket` past the change notices every socket gets.
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. } | ServerMessage::PartyChanged { .. } => {}
            message => return message,
        }
    }
}

/// Waits for a `MicBridges` change notice on `socket`.
async fn bridges_changed(socket: &mut WsClient) {
    loop {
        if let ServerMessage::Changed { topics } = socket.recv().await
            && topics.contains(&ChangeTopic::MicBridges)
        {
            return;
        }
    }
}

/// A bridge that said hello (seeing its Scarlett in Analog Surround 2.1)
/// and was approved: its id, with the bridge past its token,
/// `BridgeConnected`, `BridgeChannels` and `BridgeMicsScreen`.
async fn open_bridge(app: &TestApp, stage: &mut WsClient) -> (WsClient, BridgeId) {
    let mut bridge = app.connect_ws_at("/ws/bridge").await;
    assert!(matches!(
        bridge.recv().await,
        ServerMessage::LiveState { .. }
    ));
    bridge
        .send(&ClientMessage::BridgeHello {
            build: openstar::BUILD_ID.into(),
            host_name: "hermes".into(),
            token: None,
            interfaces: vec![],
        })
        .await;
    bridge.send(&sees_surround(false)).await;
    assert!(matches!(
        recv(&mut bridge).await,
        ServerMessage::BridgeWaiting { .. }
    ));
    let listing: MicBridges = app.get_json("/api/mic-bridges").await;
    stage
        .send(&ClientMessage::ApproveBridge {
            request_id: listing.requests[0].request_id,
        })
        .await;
    assert!(matches!(
        recv(&mut bridge).await,
        ServerMessage::BridgeApproved { .. }
    ));
    let ServerMessage::BridgeConnected { bridge_id } = recv(&mut bridge).await else {
        panic!("expected BridgeConnected");
    };
    assert!(matches!(
        recv(&mut bridge).await,
        ServerMessage::BridgeChannels { .. }
    ));
    assert!(matches!(
        recv(&mut bridge).await,
        ServerMessage::BridgeMicsScreen { .. }
    ));
    (bridge, bridge_id)
}

#[tokio::test]
async fn an_interface_not_in_pro_audio_is_listed_with_its_profile_and_no_channels() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (_bridge, _) = open_bridge(&app, &mut stage).await;

    let listing: MicBridges = app.get_json("/api/mic-bridges").await;
    let bridge = &listing.bridges[0];
    assert!(bridge.open);
    assert_eq!(bridge.not_pro_audio, vec![in_surround(false)]);
    assert_eq!(bridge.interfaces, vec![]);
    assert_eq!(bridge.channels, vec![]);
}

#[tokio::test]
async fn a_refused_switch_said_by_the_bridge_is_listed_for_the_stage() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (mut bridge, _) = open_bridge(&app, &mut stage).await;

    bridge.send(&sees_surround(true)).await;
    bridges_changed(&mut stage).await;
    let listing: MicBridges = app.get_json("/api/mic-bridges").await;
    assert_eq!(listing.bridges[0].not_pro_audio, vec![in_surround(true)]);
}

#[tokio::test]
async fn switch_to_pro_audio_on_the_stage_reaches_the_bridge() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (mut bridge, bridge_id) = open_bridge(&app, &mut stage).await;

    stage
        .send(&ClientMessage::SwitchBridgeToProAudio {
            bridge_id: bridge_id.clone(),
            device_name: CARD.into(),
        })
        .await;
    assert_eq!(
        recv(&mut bridge).await,
        ServerMessage::BridgeSwitchProfile {
            device_name: CARD.into()
        }
    );
}

#[tokio::test]
async fn only_the_stage_switches_and_only_an_open_bridge() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (bridge, bridge_id) = open_bridge(&app, &mut stage).await;

    let mut phone = app.connect_ws().await;
    assert!(matches!(
        phone.recv().await,
        ServerMessage::LiveState { .. }
    ));
    phone
        .send(&ClientMessage::SwitchBridgeToProAudio {
            bridge_id: bridge_id.clone(),
            device_name: CARD.into(),
        })
        .await;
    assert_eq!(
        recv(&mut phone).await,
        ServerMessage::Rejected {
            reason: UserMessage::NotTheStage
        }
    );

    drop(bridge);
    // Closed: its group lists no profile message, and a switch is refused.
    loop {
        bridges_changed(&mut stage).await;
        let listing: MicBridges = app.get_json("/api/mic-bridges").await;
        if !listing.bridges[0].open {
            assert_eq!(listing.bridges[0].not_pro_audio, vec![]);
            break;
        }
    }
    stage
        .send(&ClientMessage::SwitchBridgeToProAudio {
            bridge_id,
            device_name: CARD.into(),
        })
        .await;
    assert_eq!(
        recv(&mut stage).await,
        ServerMessage::Rejected {
            reason: UserMessage::BridgeNotFound
        }
    );
}

#[tokio::test]
async fn after_a_switch_the_interface_comes_back_with_its_existing_local_mic_ids() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (mut bridge, bridge_id) = open_bridge(&app, &mut stage).await;
    // Named while it was in Pro Audio on an earlier evening.
    let red = bridge_local_mic_id(&bridge_id, CARD, 1);
    stage
        .send(&ClientMessage::SetLocalMicName {
            local_mic_id: red.clone(),
            source: LocalMicSource::Bridge {
                bridge_id: bridge_id.clone(),
                device_name: CARD.into(),
                label: "Scarlett 4i4".into(),
                channel: 1,
                loopback: None,
            },
            name: "Red mic".into(),
        })
        .await;
    assert!(matches!(
        recv(&mut bridge).await,
        ServerMessage::BridgeChannels { .. }
    ));

    // The profile changed (by the button or by hand): the bridge says so.
    bridge
        .send(&ClientMessage::BridgeInterfaces {
            interfaces: vec![scarlett()],
            not_pro_audio: vec![],
        })
        .await;
    let ServerMessage::BridgeChannels { channels } = recv(&mut bridge).await else {
        panic!("expected BridgeChannels");
    };
    let named: Vec<(&str, &str)> = channels
        .iter()
        .map(|c| (c.local_mic_id.as_str(), c.name.as_str()))
        .collect();
    assert_eq!(named.len(), 4);
    assert!(named.contains(&(red.as_str(), "Red mic")));

    bridges_changed(&mut stage).await;
    let listing: MicBridges = app.get_json("/api/mic-bridges").await;
    let bridge = &listing.bridges[0];
    assert_eq!(bridge.not_pro_audio, vec![]);
    assert_eq!(bridge.interfaces, vec![scarlett()]);
    let ids: Vec<&str> = bridge
        .channels
        .iter()
        .map(|c| c.local_mic_id.as_str())
        .collect();
    assert_eq!(
        ids,
        (0..4)
            .map(|n| bridge_local_mic_id(&bridge_id, CARD, n))
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn what_another_socket_says_a_bridge_sees_is_dropped() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    stage.send(&sees_surround(false)).await;
    stage.send(&ClientMessage::Ping { nonce: 5 }).await;
    assert_eq!(recv(&mut stage).await, ServerMessage::Pong { nonce: 5 });
}
