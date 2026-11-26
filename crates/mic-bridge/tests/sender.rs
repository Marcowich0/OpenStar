//! The bridge's native sender over the real app: a test client stands in
//! for the bridge app, makes its readings and pings with
//! `openstar_mic_bridge::sender::Sender` and sends them on an approved
//! bridge socket. Nothing is sent before the Stage has answered a ping; then
//! every reading reaches the Stage under its Local mic, stamped on the
//! Stage's clock.

use openstar_mic_bridge::sender::Sender;
use openstar_protocol::bridge::{BridgeId, BridgeInterface, MicBridges, bridge_local_mic_id};
use openstar_protocol::{BridgeInput, ClientMessage, MicId, ServerMessage};
use openstar_test_harness::{TestApp, WsClient};

const DEVICE: &str = "alsa_card.usb-X-00";
const RATE: f64 = 48_000.0;
const BLOCK: usize = 480;
/// The Stage's clock runs this far ahead of the bridge's.
const STAGE_AHEAD_MS: f64 = 250_000.0;

/// The next message past the change notices every socket gets.
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

async fn heard_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 9 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 9 });
}

/// The Stage, and a bridge with one 2-channel interface it approved.
async fn stage_and_bridge(app: &TestApp) -> (WsClient, WsClient, BridgeId) {
    let mut stage = app.connect_stage().await;
    assert!(matches!(
        stage.recv().await,
        ServerMessage::LiveState { .. }
    ));
    let mut bridge = app.connect_ws_at("/ws/bridge").await;
    assert!(matches!(
        bridge.recv().await,
        ServerMessage::LiveState { .. }
    ));
    bridge
        .send(&ClientMessage::BridgeHello {
            build: openstar_mic_bridge::BUILD_ID.into(),
            host_name: "hermes".into(),
            token: None,
            interfaces: vec![BridgeInterface {
                device_name: DEVICE.into(),
                label: "Scarlett".into(),
                channels: 2,
                usb_id: None,
                twin: false,
            }],
        })
        .await;
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
    (stage, bridge, bridge_id)
}

/// Block `b` of a 2-channel capture: silence on channel 0, A4 on channel 1.
fn block(b: usize) -> Vec<f32> {
    (b * BLOCK..(b + 1) * BLOCK)
        .flat_map(|n| {
            let s = 0.5 * (2.0 * std::f64::consts::PI * 440.0 * n as f64 / RATE).sin();
            [0.0, s as f32]
        })
        .collect()
}

/// When block `b` is handled on the bridge's clock: 2 ms after its last
/// frame.
fn handled_ms(b: usize) -> f64 {
    ((b + 1) * BLOCK) as f64 / RATE * 1000.0 + 2.0
}

#[tokio::test]
async fn the_native_sender_sends_nothing_before_an_offset_then_readings_on_the_stages_clock() {
    let app = TestApp::start().await;
    let (mut stage, mut bridge, bridge_id) = stage_and_bridge(&app).await;
    let input = BridgeInput {
        device_name: DEVICE.into(),
        channel: 1,
    };
    let mic = MicId::Bridge {
        bridge_id: bridge_id.clone(),
        local_mic_id: bridge_local_mic_id(&bridge_id, DEVICE, 1),
    };
    let mut sender = Sender::new();
    sender.start(input.clone(), RATE, 0.0);

    // Before any pong: readings are made but none is sent.
    for b in 0..10 {
        assert!(
            sender
                .push_interleaved(DEVICE, &block(b), 2, handled_ms(b))
                .is_empty()
        );
    }
    heard_nothing(&mut stage).await;

    // One ping through the relay; the Stage answers on its own clock.
    let pings = sender.poll_pings(100.0);
    assert_eq!(pings.len(), 1);
    bridge.send(&pings[0]).await;
    let ServerMessage::ClockPing { mic: pinged, t0 } = recv(&mut stage).await else {
        panic!("expected a ping at the Stage");
    };
    assert_eq!(pinged, mic);
    stage
        .send(&ClientMessage::ClockPong {
            mic: mic.clone(),
            t0,
            ts: t0 + 1.0 + STAGE_AHEAD_MS,
            epoch: 1.7e12,
        })
        .await;
    let ServerMessage::ClockPong {
        t0,
        ts,
        epoch,
        input: Some(ponged),
    } = recv(&mut bridge).await
    else {
        panic!("expected a pong at the bridge");
    };
    assert_eq!(ponged, input);
    sender.receive_pong(&ponged, t0, ts, epoch, t0 + 2.0);

    // Now every reading goes, under its Local mic, on the Stage's clock.
    for b in 10..15 {
        let sent = sender.push_interleaved(DEVICE, &block(b), 2, handled_ms(b));
        assert_eq!(sent.len(), 1);
        bridge.send(&sent[0]).await;
        let ServerMessage::PitchReading { mic: from, reading } = recv(&mut stage).await else {
            panic!("expected a reading at the Stage");
        };
        assert_eq!(from, mic);
        let end_ms = ((b + 1) * BLOCK) as f64 / RATE * 1000.0;
        let expected = end_ms + 2.0 - 1024.0 / RATE * 1000.0 + STAGE_AHEAD_MS;
        assert!(
            (reading.capture_ms - expected).abs() < 1e-6,
            "{} vs {expected}",
            reading.capture_ms
        );
        assert!((reading.pitch.unwrap() - 69.0).abs() < 0.1);
    }
}
