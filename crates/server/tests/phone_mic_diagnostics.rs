//! A Phone's own Mic threshold and its mic diagnostics, over real
//! WebSockets: every browser learns the Stage output with the volume, a
//! Phone sets its own Mic threshold by hand (and only its own) with no Admin
//! PIN, the Stage sets any Phone's, a later Calibration replaces it, and a
//! Phone's `micReportRequest` reaches the Stage while the Stage's
//! `micReport` goes back to that Phone alone.

use openstar_protocol::mics::{
    CalibrationResult, MicKey, StageOutputMicSettings, StoredMicSettings, StoredMicThreshold,
    ThresholdSetBy,
};
use openstar_protocol::pitch::StageMicReport;
use openstar_protocol::{ChangeTopic, ClientMessage, MicId, PhoneId, ServerMessage, UserMessage};
use openstar_test_harness::{TestApp, WsClient};

const SPEAKERS: &str = "Speakers";

/// The next message on `socket`, past Party changes.
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::PartyChanged { .. } => {}
            message => return message,
        }
    }
}

/// Asserts that nothing arrived on `socket` before the answer to a ping.
async fn heard_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 9 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 9 });
}

/// The Stage on a fresh server, past its greeting and the Party it started.
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

/// A browser that presented `phone_id`, past the server's answer to it.
async fn open_phone(app: &TestApp, phone_id: &str) -> WsClient {
    let mut phone = app.connect_ws().await;
    assert!(matches!(
        phone.recv().await,
        ServerMessage::LiveState { .. }
    ));
    phone
        .send(&ClientMessage::Hello {
            phone_id: PhoneId(phone_id.into()),
        })
        .await;
    assert!(matches!(
        phone.recv().await,
        ServerMessage::PhoneStatus { .. }
    ));
    phone
}

/// The Stage reports `SPEAKERS`; every browser hears the volume with it.
async fn report_output(stage: &mut WsClient) {
    stage
        .send(&ClientMessage::ReportStageOutput {
            stage_browser: "stage-1".into(),
            stage_output: SPEAKERS.into(),
        })
        .await;
}

fn volume_at_speakers() -> ServerMessage {
    ServerMessage::Volume {
        volume: 80,
        stepped: false,
        stage_output: Some(SPEAKERS.into()),
    }
}

fn set_phone(phone_id: &str, reference_dbfs: f64) -> ClientMessage {
    ClientMessage::SetPhoneMicThreshold {
        stage_output: SPEAKERS.into(),
        phone_id: PhoneId(phone_id.into()),
        reference_dbfs,
    }
}

fn changed() -> ServerMessage {
    ServerMessage::Changed {
        topics: vec![ChangeTopic::MicSettings],
    }
}

async fn stored_for(app: &TestApp, phone_id: &str) -> Option<StoredMicSettings> {
    let body: StageOutputMicSettings = app
        .http()
        .get(app.url(&format!("/api/mic-settings?stageOutput={SPEAKERS}")))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    body.mics
        .into_iter()
        .find(|entry| {
            entry.mic
                == MicKey::Phone {
                    phone_id: phone_id.into(),
                }
        })
        .map(|entry| entry.settings)
}

fn by(reference_dbfs: f64, set_by: ThresholdSetBy) -> Option<StoredMicThreshold> {
    Some(StoredMicThreshold {
        reference_dbfs,
        set_by,
    })
}

#[tokio::test]
async fn a_new_browser_hears_the_volume_with_the_stage_output_it_belongs_to() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    report_output(&mut stage).await;
    assert_eq!(recv(&mut stage).await, volume_at_speakers());
    let mut late = app.connect_ws().await;
    assert!(matches!(late.recv().await, ServerMessage::LiveState { .. }));
    assert_eq!(recv(&mut late).await, volume_at_speakers());
    app.stop().await;
}

#[tokio::test]
async fn a_phone_sets_its_own_mic_threshold_without_a_pin() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut phone = open_phone(&app, "ph-1").await;
    report_output(&mut stage).await;
    assert_eq!(recv(&mut stage).await, volume_at_speakers());
    assert_eq!(recv(&mut phone).await, volume_at_speakers());

    phone.send(&set_phone("ph-1", -36.5)).await;
    assert_eq!(recv(&mut phone).await, changed());
    assert_eq!(recv(&mut stage).await, changed());
    assert_eq!(
        stored_for(&app, "ph-1").await,
        Some(StoredMicSettings {
            calibration: None,
            mic_threshold: by(-36.5, ThresholdSetBy::Hand),
        })
    );

    // A later Calibration run replaces it with its own.
    stage
        .send(&ClientMessage::StoreCalibration {
            stage_output: SPEAKERS.into(),
            results: vec![CalibrationResult {
                mic: MicKey::Phone {
                    phone_id: "ph-1".into(),
                },
                mic_delay_ms: 104.0,
                bleed_level_dbfs: -40.0,
                mic_threshold_dbfs: Some(-34.0),
            }],
        })
        .await;
    assert_eq!(recv(&mut stage).await, changed());
    let stored = stored_for(&app, "ph-1").await.unwrap();
    assert_eq!(stored.mic_threshold, by(-34.0, ThresholdSetBy::Calibration));
    app.stop().await;
}

#[tokio::test]
async fn a_phone_sets_only_its_own_and_only_at_the_stages_output() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut phone = open_phone(&app, "ph-1").await;

    // No Stage output yet.
    phone.send(&set_phone("ph-1", -36.0)).await;
    assert_eq!(
        recv(&mut phone).await,
        ServerMessage::Rejected {
            reason: UserMessage::NoStage
        }
    );
    report_output(&mut stage).await;
    assert_eq!(recv(&mut stage).await, volume_at_speakers());
    assert_eq!(recv(&mut phone).await, volume_at_speakers());

    // Another Phone's.
    phone.send(&set_phone("ph-2", -36.0)).await;
    assert_eq!(
        recv(&mut phone).await,
        ServerMessage::Rejected {
            reason: UserMessage::NotTheStage
        }
    );
    // Another output than the Stage's.
    phone
        .send(&ClientMessage::SetPhoneMicThreshold {
            stage_output: "HDMI".into(),
            phone_id: PhoneId("ph-1".into()),
            reference_dbfs: -36.0,
        })
        .await;
    assert_eq!(
        recv(&mut phone).await,
        ServerMessage::Rejected {
            reason: UserMessage::NoStage
        }
    );
    heard_nothing(&mut stage).await;
    assert_eq!(stored_for(&app, "ph-1").await, None);
    assert_eq!(stored_for(&app, "ph-2").await, None);
    app.stop().await;
}

#[tokio::test]
async fn the_stage_sets_any_phones_mic_threshold() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    report_output(&mut stage).await;
    assert_eq!(recv(&mut stage).await, volume_at_speakers());
    stage.send(&set_phone("ph-9", -41.0)).await;
    assert_eq!(recv(&mut stage).await, changed());
    assert_eq!(
        stored_for(&app, "ph-9").await.unwrap().mic_threshold,
        by(-41.0, ThresholdSetBy::Hand)
    );
    app.stop().await;
}

fn report() -> StageMicReport {
    StageMicReport {
        received_per_second: 93,
        arrival_p50_ms: Some(61.5),
        arrival_p95_ms: Some(118.0),
        arrival_max_ms: Some(240.25),
        largest_gap_ms: Some(96.0),
        late_share: Some(0.0),
        loudness_dbfs: Some(-27.5),
        mic_delay_ms: 100.0,
        mic_threshold_dbfs: -30.0,
    }
}

#[tokio::test]
async fn a_phones_report_request_reaches_the_stage_and_the_answer_only_that_phone() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut phone = open_phone(&app, "ph-1").await;
    let mut bystander = open_phone(&app, "ph-2").await;

    phone.send(&ClientMessage::MicReportRequest).await;
    let mic = MicId::Phone {
        phone_id: PhoneId("ph-1".into()),
    };
    assert_eq!(
        recv(&mut stage).await,
        ServerMessage::MicReportRequest { mic: mic.clone() }
    );
    stage
        .send(&ClientMessage::MicReport {
            mic,
            report: report(),
        })
        .await;
    assert_eq!(
        recv(&mut phone).await,
        ServerMessage::MicReport { report: report() }
    );
    heard_nothing(&mut bystander).await;

    // Only the Stage answers.
    bystander
        .send(&ClientMessage::MicReport {
            mic: MicId::Phone {
                phone_id: PhoneId("ph-1".into()),
            },
            report: report(),
        })
        .await;
    assert_eq!(
        recv(&mut bystander).await,
        ServerMessage::Rejected {
            reason: UserMessage::NotTheStage
        }
    );
    heard_nothing(&mut phone).await;
    app.stop().await;
}
