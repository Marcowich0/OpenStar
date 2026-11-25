//! Mic delays, bleed levels and Mic thresholds kept per (Mic, Stage output),
//! over the real app: the Stage writes over its WebSocket, anyone reads
//! `GET /api/mic-settings`.

use openstar::db::Database;
use openstar::mic_settings;
use openstar_protocol::mics::{
    CalibrationResult, MicKey, MicSettingsEntry, StageOutputMicSettings, StoredCalibration,
    StoredMicSettings, StoredMicThreshold, ThresholdSetBy,
};
use openstar_protocol::{ChangeTopic, ClientMessage, ServerMessage, UserMessage};
use openstar_test_harness::{TestApp, WsClient};

const SPEAKERS: &str = "Built-in Audio Analog Stereo";
const TV: &str = "HDMI / DisplayPort 1 Output";

fn phone(id: &str) -> MicKey {
    MicKey::Phone {
        phone_id: id.into(),
    }
}

fn local_mic(id: &str) -> MicKey {
    MicKey::LocalMic {
        local_mic_id: id.into(),
    }
}

fn result(mic: MicKey, delay: f64, bleed: f64, threshold: Option<f64>) -> CalibrationResult {
    CalibrationResult {
        mic,
        mic_delay_ms: delay,
        bleed_level_dbfs: bleed,
        mic_threshold_dbfs: threshold,
    }
}

fn calibrated(
    delay: f64,
    bleed: f64,
    threshold: Option<(f64, ThresholdSetBy)>,
) -> StoredMicSettings {
    StoredMicSettings {
        calibration: Some(StoredCalibration {
            mic_delay_ms: delay,
            bleed_level_dbfs: bleed,
        }),
        mic_threshold: threshold.map(|(reference_dbfs, set_by)| StoredMicThreshold {
            reference_dbfs,
            set_by,
        }),
    }
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

/// Sends a write and waits until the server says Mic settings changed.
async fn write(stage: &mut WsClient, message: ClientMessage) {
    stage.send(&message).await;
    assert_eq!(
        stage.recv().await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::MicSettings]
        }
    );
}

async fn store(stage: &mut WsClient, output: &str, results: Vec<CalibrationResult>) {
    write(
        stage,
        ClientMessage::StoreCalibration {
            stage_output: output.into(),
            results,
        },
    )
    .await;
}

async fn set_by_hand(stage: &mut WsClient, output: &str, local_mic_id: &str, dbfs: f64) {
    write(
        stage,
        ClientMessage::SetMicThreshold {
            stage_output: output.into(),
            local_mic_id: local_mic_id.into(),
            reference_dbfs: dbfs,
        },
    )
    .await;
}

/// Every Mic's values at `output`, sorted for comparison.
async fn read(app: &TestApp, output: &str) -> Vec<MicSettingsEntry> {
    let url = app.url(&format!(
        "/api/mic-settings?stageOutput={}",
        percent_encode(output)
    ));
    let body: StageOutputMicSettings = app
        .http()
        .get(url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body.stage_output, output);
    let mut mics = body.mics;
    mics.sort_by_key(|entry| format!("{:?}", entry.mic));
    mics
}

/// Encodes everything but unreserved characters, as a query value needs.
fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                char::from(byte).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn entry(mic: MicKey, settings: StoredMicSettings) -> MicSettingsEntry {
    MicSettingsEntry { mic, settings }
}

#[tokio::test]
async fn a_run_is_stored_per_mic_at_its_stage_output_and_read_back_only_there() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    store(
        &mut stage,
        SPEAKERS,
        vec![
            result(phone("phone-a"), 112.5, -41.25, None),
            result(local_mic("red"), 23.0, -52.0, Some(-46.0)),
        ],
    )
    .await;
    store(
        &mut stage,
        TV,
        vec![result(phone("phone-a"), 180.0, -38.0, None)],
    )
    .await;

    assert_eq!(
        read(&app, SPEAKERS).await,
        vec![
            entry(
                local_mic("red"),
                calibrated(23.0, -52.0, Some((-46.0, ThresholdSetBy::Calibration)))
            ),
            entry(phone("phone-a"), calibrated(112.5, -41.25, None)),
        ]
    );
    assert_eq!(
        read(&app, TV).await,
        vec![entry(phone("phone-a"), calibrated(180.0, -38.0, None))]
    );
    assert_eq!(read(&app, "Some other output").await, vec![]);
}

#[tokio::test]
async fn a_mic_left_out_of_a_run_keeps_every_value_it_had() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    store(
        &mut stage,
        SPEAKERS,
        vec![
            result(phone("phone-a"), 110.0, -40.0, None),
            result(local_mic("red"), 20.0, -50.0, Some(-44.0)),
        ],
    )
    .await;
    // The second run: the Phone succeeds again, the Local mic failed.
    store(
        &mut stage,
        SPEAKERS,
        vec![result(phone("phone-a"), 95.0, -43.0, None)],
    )
    .await;

    assert_eq!(
        read(&app, SPEAKERS).await,
        vec![
            entry(
                local_mic("red"),
                calibrated(20.0, -50.0, Some((-44.0, ThresholdSetBy::Calibration)))
            ),
            entry(phone("phone-a"), calibrated(95.0, -43.0, None)),
        ]
    );
}

#[tokio::test]
async fn a_local_mics_threshold_is_last_write_wins_between_calibration_and_hand() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let red = || local_mic("red");

    store(
        &mut stage,
        SPEAKERS,
        vec![result(red(), 20.0, -50.0, Some(-44.0))],
    )
    .await;
    set_by_hand(&mut stage, SPEAKERS, "red", -38.5).await;
    assert_eq!(
        read(&app, SPEAKERS).await,
        vec![entry(
            red(),
            calibrated(20.0, -50.0, Some((-38.5, ThresholdSetBy::Hand)))
        )]
    );

    store(
        &mut stage,
        SPEAKERS,
        vec![result(red(), 21.0, -49.0, Some(-43.0))],
    )
    .await;
    assert_eq!(
        read(&app, SPEAKERS).await,
        vec![entry(
            red(),
            calibrated(21.0, -49.0, Some((-43.0, ThresholdSetBy::Calibration)))
        )]
    );
}

#[tokio::test]
async fn a_hand_setting_on_a_never_calibrated_local_mic_stores_a_threshold_and_no_delay() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    set_by_hand(&mut stage, SPEAKERS, "blue", -35.0).await;
    assert_eq!(
        read(&app, SPEAKERS).await,
        vec![entry(
            local_mic("blue"),
            StoredMicSettings {
                calibration: None,
                mic_threshold: Some(StoredMicThreshold {
                    reference_dbfs: -35.0,
                    set_by: ThresholdSetBy::Hand,
                }),
            }
        )]
    );
}

#[tokio::test]
async fn values_survive_a_new_party_and_a_restart() {
    let mut app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    store(
        &mut stage,
        SPEAKERS,
        vec![
            result(phone("phone-a"), 110.0, -40.0, None),
            result(local_mic("red"), 20.0, -50.0, Some(-44.0)),
        ],
    )
    .await;
    let before = read(&app, SPEAKERS).await;
    assert_eq!(before.len(), 2);

    stage.send(&ClientMessage::NewParty).await;
    assert!(matches!(
        stage.recv().await,
        ServerMessage::PartyChanged { .. }
    ));
    assert_eq!(read(&app, SPEAKERS).await, before);

    app.restart().await;
    assert_eq!(read(&app, SPEAKERS).await, before);
}

#[tokio::test]
async fn two_phone_ids_keep_separate_values() {
    // Two Phones holding one Profile are still two Phone ids; the Profile
    // plays no part in the key.
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    store(
        &mut stage,
        SPEAKERS,
        vec![
            result(phone("phone-a"), 100.0, -40.0, None),
            result(phone("phone-b"), 320.0, -33.0, None),
        ],
    )
    .await;
    assert_eq!(
        read(&app, SPEAKERS).await,
        vec![
            entry(phone("phone-a"), calibrated(100.0, -40.0, None)),
            entry(phone("phone-b"), calibrated(320.0, -33.0, None)),
        ]
    );
}

#[tokio::test]
async fn a_local_mics_values_move_to_a_new_id_and_can_be_deleted_at_every_output() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    store(
        &mut stage,
        SPEAKERS,
        vec![
            result(local_mic("old"), 20.0, -50.0, Some(-44.0)),
            result(local_mic("other"), 30.0, -48.0, Some(-42.0)),
        ],
    )
    .await;
    set_by_hand(&mut stage, TV, "old", -36.0).await;

    // The store's own operations (Find it, Forget), on the app's database.
    let db = Database::open(app.appdata_dir()).await.unwrap().database;
    mic_settings::move_local_mic(&db, "old", "new")
        .await
        .unwrap();

    let other = entry(
        local_mic("other"),
        calibrated(30.0, -48.0, Some((-42.0, ThresholdSetBy::Calibration))),
    );
    assert_eq!(
        read(&app, SPEAKERS).await,
        vec![
            entry(
                local_mic("new"),
                calibrated(20.0, -50.0, Some((-44.0, ThresholdSetBy::Calibration)))
            ),
            other.clone(),
        ]
    );
    assert_eq!(
        read(&app, TV).await,
        vec![entry(
            local_mic("new"),
            StoredMicSettings {
                calibration: None,
                mic_threshold: Some(StoredMicThreshold {
                    reference_dbfs: -36.0,
                    set_by: ThresholdSetBy::Hand,
                }),
            }
        )]
    );

    mic_settings::forget_local_mic(&db, "new").await.unwrap();
    assert_eq!(read(&app, SPEAKERS).await, vec![other]);
    assert_eq!(read(&app, TV).await, vec![]);
}

#[tokio::test]
async fn only_the_active_stage_may_write_and_no_admin_pin_is_needed() {
    let app = TestApp::start().await;
    let mut old_stage = open_stage(&app).await;
    let mut browser = app.connect_ws().await;
    assert!(matches!(
        browser.recv().await,
        ServerMessage::LiveState { .. }
    ));
    let mut stage = app.connect_stage().await;
    assert!(matches!(
        stage.recv().await,
        ServerMessage::LiveState { .. }
    ));
    assert_eq!(old_stage.recv().await, ServerMessage::StageMoved);

    let writes = [
        ClientMessage::StoreCalibration {
            stage_output: SPEAKERS.into(),
            results: vec![result(phone("phone-a"), 100.0, -40.0, None)],
        },
        ClientMessage::SetMicThreshold {
            stage_output: SPEAKERS.into(),
            local_mic_id: "red".into(),
            reference_dbfs: -30.0,
        },
    ];
    for socket in [&mut browser, &mut old_stage] {
        for message in &writes {
            socket.send(message).await;
            assert_eq!(
                socket.recv().await,
                ServerMessage::Rejected {
                    reason: UserMessage::NotTheStage
                }
            );
        }
    }
    assert_eq!(read(&app, SPEAKERS).await, vec![]);

    // The active Stage writes with no Unlock, and every browser hears of it.
    for message in writes {
        write(&mut stage, message).await;
        assert_eq!(
            browser.recv().await,
            ServerMessage::Changed {
                topics: vec![ChangeTopic::MicSettings]
            }
        );
    }
    assert_eq!(read(&app, SPEAKERS).await.len(), 2);
}
