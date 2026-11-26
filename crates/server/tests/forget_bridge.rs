//! Forget a Mic bridge, over the real app: `DELETE /api/mic-bridges/{id}`
//! needs an Unlock (it deletes kept data), and with one removes the bridge's
//! approval and its Local mics with every value stored against them. A
//! forgotten bridge that connects again waits for approval like a new one.

use openstar_protocol::bridge::{BridgeId, BridgeInterface, MicBridges};
use openstar_protocol::mics::{
    CalibrationResult, LocalMic, LocalMicSource, MicKey, StageOutputMicSettings,
};
use openstar_protocol::{ChangeTopic, ClientMessage, ServerMessage, UserMessage};
use openstar_test_harness::{TestApp, WsClient};
use reqwest::StatusCode;

const SPEAKERS: &str = "speakers";

fn hello(token: Option<&str>) -> ClientMessage {
    ClientMessage::BridgeHello {
        build: openstar::BUILD_ID.into(),
        host_name: "hermes".into(),
        token: token.map(Into::into),
        interfaces: vec![BridgeInterface {
            device_name: "multichannel.wav".into(),
            label: "multichannel.wav".into(),
            channels: 4,
        }],
    }
}

async fn open_stage(app: &TestApp) -> WsClient {
    let mut stage = app.connect_stage().await;
    assert!(matches!(
        stage.recv_past_local_mics().await,
        ServerMessage::LiveState { is_stage: true, .. }
    ));
    assert!(matches!(
        stage.recv_past_local_mics().await,
        ServerMessage::PartyChanged { .. }
    ));
    stage
}

async fn connect_bridge(app: &TestApp) -> WsClient {
    let mut bridge = app.connect_ws_at("/ws/bridge").await;
    assert!(matches!(
        bridge.recv().await,
        ServerMessage::LiveState { .. }
    ));
    bridge
}

/// The next message meant for a bridge, past the notices every socket gets.
async fn bridge_recv(bridge: &mut WsClient) -> ServerMessage {
    loop {
        match bridge.recv().await {
            ServerMessage::Changed { .. }
            | ServerMessage::PartyChanged { .. }
            | ServerMessage::BridgeMicsScreen { .. }
            | ServerMessage::BridgeChannels { .. } => {}
            message => return message,
        }
    }
}

/// The Stage's next message other than a Mic-closed or Local mics notice.
async fn stage_recv(stage: &mut WsClient) -> ServerMessage {
    loop {
        match stage.recv_past_local_mics().await {
            ServerMessage::MicClosed { .. } => {}
            message => return message,
        }
    }
}

async fn mic_bridges(app: &TestApp) -> MicBridges {
    app.get_json("/api/mic-bridges").await
}

async fn wait(bridge: &mut WsClient, token: Option<&str>) -> String {
    bridge.send(&hello(token)).await;
    match bridge_recv(bridge).await {
        ServerMessage::BridgeWaiting { code } => code,
        other => panic!("expected BridgeWaiting, got {other:?}"),
    }
}

/// A bridge approved on the Stage: its token and id.
async fn approved_bridge(
    app: &TestApp,
    stage: &mut WsClient,
    bridge: &mut WsClient,
) -> (String, BridgeId) {
    wait(bridge, None).await;
    let request_id = mic_bridges(app).await.requests[0].request_id;
    stage
        .send(&ClientMessage::ApproveBridge { request_id })
        .await;
    let token = match bridge_recv(bridge).await {
        ServerMessage::BridgeApproved { token } => token,
        other => panic!("expected BridgeApproved, got {other:?}"),
    };
    let bridge_id = match bridge_recv(bridge).await {
        ServerMessage::BridgeConnected { bridge_id } => bridge_id,
        other => panic!("expected BridgeConnected, got {other:?}"),
    };
    (token, bridge_id)
}

/// Sends a Stage write and waits for its Mic settings notice.
async fn write(stage: &mut WsClient, message: ClientMessage) {
    stage.send(&message).await;
    loop {
        match stage_recv(stage).await {
            ServerMessage::Changed { topics } if topics == [ChangeTopic::MicSettings] => return,
            refused @ ServerMessage::Rejected { .. } => panic!("refused: {refused:?}"),
            _ => {}
        }
    }
}

/// Switches channel `n` of the approved bridge on, names it, calibrates it
/// at the speakers and sets its threshold by hand; returns its Local mic id.
async fn keep_values_for_channel(app: &TestApp, stage: &mut WsClient, n: usize) -> String {
    let channel = mic_bridges(app).await.bridges[0].channels[n].clone();
    let id = channel.local_mic_id.clone();
    write(
        stage,
        ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: id.clone(),
            source: channel.source.clone(),
            switched_on: true,
        },
    )
    .await;
    write(
        stage,
        ClientMessage::SetLocalMicName {
            local_mic_id: id.clone(),
            source: channel.source,
            name: "Red".into(),
        },
    )
    .await;
    write(
        stage,
        ClientMessage::StoreCalibration {
            stage_output: SPEAKERS.into(),
            results: vec![CalibrationResult {
                mic: MicKey::LocalMic {
                    local_mic_id: id.clone(),
                },
                mic_delay_ms: 20.0,
                bleed_level_dbfs: -50.0,
                mic_threshold_dbfs: Some(-44.0),
            }],
        },
    )
    .await;
    write(
        stage,
        ClientMessage::SetMicThreshold {
            stage_output: "tv".into(),
            local_mic_id: id.clone(),
            reference_dbfs: -40.0,
        },
    )
    .await;
    id
}

async fn mic_settings(app: &TestApp, output: &str) -> Vec<MicKey> {
    let body: StageOutputMicSettings = app
        .get_json(&format!("/api/mic-settings?stageOutput={output}"))
        .await;
    body.mics.into_iter().map(|entry| entry.mic).collect()
}

async fn forget(app: &TestApp, bridge_id: &BridgeId, cookie: Option<&str>) -> reqwest::Response {
    let mut request = app
        .http()
        .delete(app.url(&format!("/api/mic-bridges/{}", bridge_id.0)));
    if let Some(cookie) = cookie {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    request.send().await.unwrap()
}

#[tokio::test]
async fn forget_without_an_unlock_is_refused_and_the_bridge_stays_approved() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut bridge = connect_bridge(&app).await;
    let (token, bridge_id) = approved_bridge(&app, &mut stage, &mut bridge).await;
    let local_mic_id = keep_values_for_channel(&app, &mut stage, 1).await;

    let response = forget(&app, &bridge_id, None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    assert_eq!(mic_bridges(&app).await.bridges.len(), 1);
    let kept: Vec<LocalMic> = app.get_json("/api/local-mics").await;
    assert_eq!(kept.len(), 1);
    assert_eq!(
        mic_settings(&app, SPEAKERS).await,
        vec![MicKey::LocalMic { local_mic_id }]
    );
    // Its token still lets it straight back in.
    drop(bridge);
    let mut again = connect_bridge(&app).await;
    again.send(&hello(Some(&token))).await;
    assert!(matches!(
        bridge_recv(&mut again).await,
        ServerMessage::BridgeConnected { .. }
    ));
}

#[tokio::test]
async fn forget_with_an_unlock_removes_the_approval_and_every_value_of_its_local_mics() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut bridge = connect_bridge(&app).await;
    let (_, bridge_id) = approved_bridge(&app, &mut stage, &mut bridge).await;
    keep_values_for_channel(&app, &mut stage, 1).await;
    keep_values_for_channel(&app, &mut stage, 3).await;
    // A browser Local mic's values are not the bridge's: they stay.
    let browser_mic = "browser:stage:usb:0".to_owned();
    write(
        &mut stage,
        ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: browser_mic.clone(),
            source: LocalMicSource::Browser {
                stage_browser: "stage".into(),
                device_id: "usb".into(),
                label: "USB".into(),
                channel: 0,
                stereo: false,
            },
            switched_on: true,
        },
    )
    .await;
    write(
        &mut stage,
        ClientMessage::SetMicThreshold {
            stage_output: SPEAKERS.into(),
            local_mic_id: browser_mic.clone(),
            reference_dbfs: -45.0,
        },
    )
    .await;

    let cookie = app.unlock().await;
    let response = forget(&app, &bridge_id, Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    // Its connection is closed, and it is no longer approved.
    bridge.closed().await;
    let listing = mic_bridges(&app).await;
    assert!(listing.bridges.is_empty(), "{listing:?}");
    let kept: Vec<LocalMic> = app.get_json("/api/local-mics").await;
    let kept: Vec<String> = kept.into_iter().map(|mic| mic.local_mic_id).collect();
    assert_eq!(kept, vec![browser_mic.clone()]);
    let browser_only = vec![MicKey::LocalMic {
        local_mic_id: browser_mic,
    }];
    assert_eq!(mic_settings(&app, SPEAKERS).await, browser_only);
    assert!(mic_settings(&app, "tv").await.is_empty());
}

#[tokio::test]
async fn a_forgotten_bridge_that_connects_again_waits_with_a_new_code_also_after_a_restart() {
    let mut app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut bridge = connect_bridge(&app).await;
    let (token, bridge_id) = approved_bridge(&app, &mut stage, &mut bridge).await;

    let cookie = app.unlock().await;
    let response = forget(&app, &bridge_id, Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    bridge.closed().await;

    let mut again = connect_bridge(&app).await;
    let code = wait(&mut again, Some(&token)).await;
    assert_eq!(code.len(), 4);
    let listing = mic_bridges(&app).await;
    assert!(listing.bridges.is_empty());
    assert_eq!(listing.requests.len(), 1);
    assert_eq!(listing.requests[0].code, code);
    drop(again);
    drop(stage);

    // The approval is gone from the database too.
    app.restart().await;
    let mut after = connect_bridge(&app).await;
    wait(&mut after, Some(&token)).await;
}

#[tokio::test]
async fn forgetting_a_bridge_that_is_not_approved_answers_not_found() {
    let app = TestApp::start().await;
    let cookie = app.unlock().await;
    let response = forget(&app, &BridgeId("ab".into()), Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let message: UserMessage = response.json().await.unwrap();
    assert_eq!(message, UserMessage::BridgeNotFound);
}

#[tokio::test]
async fn approving_switching_renaming_and_thresholds_stay_pin_free() {
    // Each step below runs with no Unlock; `keep_values_for_channel` would
    // panic on a refusal.
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut bridge = connect_bridge(&app).await;
    approved_bridge(&app, &mut stage, &mut bridge).await;
    let id = keep_values_for_channel(&app, &mut stage, 0).await;
    let kept: Vec<LocalMic> = app.get_json("/api/local-mics").await;
    assert_eq!(kept[0].local_mic_id, id);
    assert_eq!(kept[0].name, "Red");
}
