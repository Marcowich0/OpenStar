//! Local mics the Stage browser reads, over the real app: the Stage switches
//! a channel on or off over its WebSocket, anyone reads `GET /api/local-mics`,
//! and what is kept survives a restart. It names a Local mic and re-links
//! one that has gone missing to a new channel (Find it).

use openstar_protocol::mics::{
    CalibrationResult, LocalMic, LocalMicSource, MicKey, MicSettingsEntry, StageOutputMicSettings,
};
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
    } = source
    else {
        unreachable!("a browser Local mic");
    };
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

fn browser_source(device_id: &str, label: &str, channel: u32) -> LocalMicSource {
    LocalMicSource::Browser {
        stage_browser: "stage-1".into(),
        device_id: device_id.into(),
        label: label.into(),
        channel,
        stereo: true,
    }
}

async fn expect_changed(stage: &mut WsClient) {
    assert_eq!(
        stage.recv().await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::MicSettings]
        }
    );
}

async fn rename(stage: &mut WsClient, id: &str, source: &LocalMicSource, name: &str) {
    stage
        .send(&ClientMessage::SetLocalMicName {
            local_mic_id: id.into(),
            source: source.clone(),
            name: name.into(),
        })
        .await;
    expect_changed(stage).await;
}

#[tokio::test]
async fn naming_a_local_mic_keeps_whether_it_is_on_and_survives_a_restart() {
    let mut app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (id, source) = left_of_dongle();
    switch(&mut stage, &id, &source, true).await;

    rename(&mut stage, &id, &source, "  Red mic ").await;
    let kept = vec![LocalMic {
        local_mic_id: id.clone(),
        source: source.clone(),
        name: "Red mic".into(),
        switched_on: true,
    }];
    assert_eq!(read(&app).await, kept);

    drop(stage);
    app.restart().await;
    assert_eq!(read(&app).await, kept);
}

#[tokio::test]
async fn an_empty_name_is_stored_empty_and_naming_a_new_channel_keeps_it_switched_off() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (id, source) = left_of_dongle();

    rename(&mut stage, &id, &source, "Red mic").await;
    rename(&mut stage, &id, &source, "   ").await;
    assert_eq!(
        read(&app).await,
        vec![LocalMic {
            local_mic_id: id,
            source,
            name: String::new(),
            switched_on: false,
        }]
    );
}

#[tokio::test]
async fn only_the_active_stage_names_a_local_mic() {
    let app = TestApp::start().await;
    let _stage = open_stage(&app).await;
    let mut phone = app.connect_ws().await;
    assert!(matches!(
        phone.recv().await,
        ServerMessage::LiveState { .. }
    ));
    let (id, source) = left_of_dongle();
    phone
        .send(&ClientMessage::SetLocalMicName {
            local_mic_id: id,
            source,
            name: "Red mic".into(),
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

async fn relink(stage: &mut WsClient, from: &str, to: &str, source: &LocalMicSource) {
    stage
        .send(&ClientMessage::RelinkLocalMic {
            local_mic_id: from.into(),
            new_local_mic_id: to.into(),
            source: source.clone(),
        })
        .await;
}

#[tokio::test]
async fn find_it_moves_the_name_the_switch_and_every_mic_setting_to_the_new_channel() {
    let mut app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let old = "browser:stage-1:dev-old:1";
    let old_source = browser_source("dev-old", "USB Audio", 1);
    switch(&mut stage, old, &old_source, true).await;
    rename(&mut stage, old, &old_source, "Red mic").await;
    for output in ["speakers", "hdmi"] {
        stage
            .send(&ClientMessage::StoreCalibration {
                stage_output: output.into(),
                results: vec![CalibrationResult {
                    mic: MicKey::LocalMic {
                        local_mic_id: old.into(),
                    },
                    mic_delay_ms: 42.0,
                    bleed_level_dbfs: -51.0,
                    mic_threshold_dbfs: None,
                }],
            })
            .await;
        expect_changed(&mut stage).await;
        stage
            .send(&ClientMessage::SetMicThreshold {
                stage_output: output.into(),
                local_mic_id: old.into(),
                reference_dbfs: -33.0,
            })
            .await;
        expect_changed(&mut stage).await;
    }
    let before_speakers = mic_settings(&app, "speakers").await;
    let before_hdmi = mic_settings(&app, "hdmi").await;

    let new = "browser:stage-1:dev-new:0";
    let new_source = browser_source("dev-new", "USB Audio Pro", 0);
    relink(&mut stage, old, new, &new_source).await;
    expect_changed(&mut stage).await;

    let kept = vec![LocalMic {
        local_mic_id: new.into(),
        source: new_source,
        name: "Red mic".into(),
        switched_on: true,
    }];
    assert_eq!(read(&app).await, kept);
    let moved = |before: StageOutputMicSettings| StageOutputMicSettings {
        mics: before
            .mics
            .into_iter()
            .map(|entry| MicSettingsEntry {
                mic: MicKey::LocalMic {
                    local_mic_id: new.into(),
                },
                ..entry
            })
            .collect(),
        ..before
    };
    assert_eq!(before_speakers.mics.len(), 1);
    assert_eq!(mic_settings(&app, "speakers").await, moved(before_speakers));
    assert_eq!(mic_settings(&app, "hdmi").await, moved(before_hdmi));

    drop(stage);
    app.restart().await;
    assert_eq!(read(&app).await, kept);
}

#[tokio::test]
async fn find_it_refuses_a_channel_that_is_already_a_local_mic_and_a_local_mic_that_is_gone() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (id, source) = left_of_dongle();
    let other = "browser:stage-1:dev-abc:1";
    let other_source = browser_source("dev-abc", "USB Audio", 1);
    switch(&mut stage, &id, &source, true).await;
    switch(&mut stage, other, &other_source, false).await;
    let kept = read(&app).await;

    relink(&mut stage, &id, other, &other_source).await;
    assert_eq!(
        stage.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::ChannelAlreadyLocalMic
        }
    );
    relink(
        &mut stage,
        "browser:stage-1:gone:0",
        "browser:stage-1:new:0",
        &source,
    )
    .await;
    assert_eq!(
        stage.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::LocalMicNotFound
        }
    );
    assert_eq!(read(&app).await, kept);
}

#[tokio::test]
async fn only_the_active_stage_uses_find_it() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (id, source) = left_of_dongle();
    switch(&mut stage, &id, &source, true).await;
    let mut phone = app.connect_ws().await;
    assert!(matches!(
        phone.recv().await,
        ServerMessage::LiveState { .. }
    ));
    relink(&mut phone, &id, "browser:stage-1:new:0", &source).await;
    assert_eq!(
        phone.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::NotTheStage
        }
    );
    assert_eq!(read(&app).await.len(), 1);
    assert_eq!(read(&app).await[0].local_mic_id, id);
}

async fn mic_settings(app: &TestApp, output: &str) -> StageOutputMicSettings {
    app.http()
        .get(app.url(&format!("/api/mic-settings?stageOutput={output}")))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}
