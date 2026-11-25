//! Local mics the Stage browser reads, over the real app: the Stage switches
//! a channel on or off over its WebSocket, anyone reads `GET /api/local-mics`,
//! and what is kept survives a restart.

use openstar_protocol::mics::{LocalMic, LocalMicSource};
use openstar_protocol::{ChangeTopic, ClientMessage, ServerMessage, UserMessage};
use openstar_test_harness::{TestApp, WsClient};

fn left_of_dongle() -> (String, LocalMicSource) {
    (
        "browser:stage-1:dev-abc:0".into(),
        LocalMicSource::Browser {
            stage_browser: "stage-1".into(),
            device_id: "dev-abc".into(),
            label: "USB Audio".into(),
            channel: 0,
            stereo: true,
        },
    )
}

/// Opens the Stage on a fresh server, past its live state and the Party it
/// started.
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

async fn switch(stage: &mut WsClient, id: &str, source: &LocalMicSource, on: bool) {
    stage
        .send(&ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: id.into(),
            source: source.clone(),
            switched_on: on,
        })
        .await;
    assert_eq!(
        stage.recv().await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::MicSettings]
        }
    );
}

async fn read(app: &TestApp) -> Vec<LocalMic> {
    app.http()
        .get(app.url("/api/local-mics"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn a_fresh_server_keeps_no_local_mic() {
    let app = TestApp::start().await;
    assert_eq!(read(&app).await, vec![]);
}

#[tokio::test]
async fn switching_a_channel_on_keeps_it_with_an_empty_name_and_survives_a_restart() {
    let mut app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (id, source) = left_of_dongle();

    switch(&mut stage, &id, &source, true).await;
    let kept = vec![LocalMic {
        local_mic_id: id.clone(),
        source: source.clone(),
        name: String::new(),
        switched_on: true,
    }];
    assert_eq!(read(&app).await, kept);

    drop(stage);
    app.restart().await;
    assert_eq!(read(&app).await, kept);
}

#[tokio::test]
async fn switching_off_is_kept_too_and_a_new_label_replaces_the_old() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (id, source) = left_of_dongle();
    switch(&mut stage, &id, &source, true).await;

    let LocalMicSource::Browser {
        stage_browser,
        device_id,
        channel,
        stereo,
        ..
    } = source;
    let relabelled = LocalMicSource::Browser {
        stage_browser,
        device_id,
        label: "USB Audio Pro".into(),
        channel,
        stereo,
    };
    switch(&mut stage, &id, &relabelled, false).await;

    assert_eq!(
        read(&app).await,
        vec![LocalMic {
            local_mic_id: id,
            source: relabelled,
            name: String::new(),
            switched_on: false,
        }]
    );
}

#[tokio::test]
async fn only_the_active_stage_switches_a_local_mic() {
    let app = TestApp::start().await;
    let _stage = open_stage(&app).await;
    let mut phone = app.connect_ws().await;
    assert!(matches!(
        phone.recv().await,
        ServerMessage::LiveState { .. }
    ));
    let (id, source) = left_of_dongle();
    phone
        .send(&ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: id,
            source,
            switched_on: true,
        })
        .await;
    assert_eq!(
        phone.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::NotTheStage
        }
    );
    assert_eq!(read(&app).await, vec![]);
}
