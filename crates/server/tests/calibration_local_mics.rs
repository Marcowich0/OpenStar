//! Local mics in Calibrate mics (#210), over the real app. The checklist
//! lists every switched-on Local mic, unticked, after the joined Phones. A
//! chosen Local mic is ready once its capture runs: a Stage-browser Local mic
//! when the Stage reports its device open, a bridge Local mic while its Mic
//! bridge is connected (and that bridge is told the channel detects). A
//! success stores its Mic delay, bleed level and Mic threshold, marked set by
//! Calibration. "Calibrate this mic now" starts the run with that Local mic
//! alone. A test client stands in for the Mic bridge.

use openstar_protocol::bridge::{BridgeId, BridgeInterface, MicBridges, bridge_local_mic_id};
use openstar_protocol::mics::{
    CalibrationMic, CalibrationOutcome, CalibrationPhase, CalibrationResult, CalibrationRun,
    LocalMicSource, MicKey, MicSettingsEntry, StageOutputMicSettings, StoredCalibration,
    StoredMicSettings, StoredMicThreshold, ThresholdSetBy,
};
use openstar_protocol::profile::{Avatar, AvatarKey, PaletteKey};
use openstar_protocol::{
    BridgeInput, ClientMessage, JoinAs, JoinCode, NewGuest, PartySnapshot, PhoneId, ServerMessage,
    UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

const SPEAKERS: &str = "Built-in Audio Analog Stereo";
const DEVICE: &str = "multichannel.wav";

fn phone_key() -> MicKey {
    MicKey::Phone {
        phone_id: "4b1d8f0e-0000-4000-8000-000000000001".into(),
    }
}

fn local(id: &str) -> MicKey {
    MicKey::LocalMic {
        local_mic_id: id.into(),
    }
}

fn entry(mic: MicKey, chosen: bool, ready: bool) -> CalibrationMic {
    CalibrationMic {
        mic,
        chosen,
        ready,
        outcome: None,
    }
}

fn at(phase: CalibrationPhase, mics: Vec<CalibrationMic>) -> Option<CalibrationRun> {
    Some(CalibrationRun { phase, mics })
}

/// The next message on `socket`, past change notices, Party changes and
/// volume reports.
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. }
            | ServerMessage::PartyChanged { .. }
            | ServerMessage::Volume { .. }
            | ServerMessage::LocalMicLevels { .. }
            | ServerMessage::MicClosed { .. } => {}
            message => return message,
        }
    }
}

/// The next Calibration run told to `socket`.
async fn run(socket: &mut WsClient) -> Option<CalibrationRun> {
    match recv(socket).await {
        ServerMessage::Calibration { run } => run,
        other => panic!("expected the Calibration run, got {other:?}"),
    }
}

/// `socket` hears runs until `expected`.
async fn comes_to(socket: &mut WsClient, expected: &Option<CalibrationRun>) {
    loop {
        let heard = run(socket).await;
        if &heard == expected {
            return;
        }
    }
}

/// The refusal of `message`, past any run `socket` hears meanwhile.
async fn refused(socket: &mut WsClient, message: ClientMessage) -> UserMessage {
    socket.send(&message).await;
    loop {
        match recv(socket).await {
            ServerMessage::Rejected { reason } => return reason,
            ServerMessage::Calibration { .. } => {}
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
}

/// The Party of the next Party change on `stage` whose Local mics satisfy
/// `done`.
async fn party_until(stage: &mut WsClient, done: impl Fn(&PartySnapshot) -> bool) -> PartySnapshot {
    loop {
        if let ServerMessage::PartyChanged { party, .. } = stage.recv().await
            && done(&party)
        {
            return party;
        }
    }
}

/// Opens the Stage, reports its output and returns it with the Join code.
async fn open_stage(app: &TestApp) -> (WsClient, JoinCode) {
    let mut stage = app.connect_stage().await;
    let mut code = match stage.recv().await {
        ServerMessage::LiveState {
            is_stage: true,
            party,
            ..
        } => party.map(|party| party.join_code),
        other => panic!("expected the live state first, got {other:?}"),
    };
    if code.is_none() {
        match stage.recv().await {
            ServerMessage::PartyChanged { party, .. } => code = Some(party.join_code),
            other => panic!("expected the first Party, got {other:?}"),
        }
    }
    stage
        .send(&ClientMessage::ReportStageOutput {
            stage_browser: "stage-1".into(),
            stage_output: SPEAKERS.into(),
        })
        .await;
    loop {
        if let ServerMessage::Volume { .. } = stage.recv().await {
            break;
        }
    }
    (stage, code.unwrap())
}

async fn joined_phone(app: &TestApp, code: &JoinCode) -> WsClient {
    let mut phone = app.connect_ws().await;
    assert!(matches!(
        recv(&mut phone).await,
        ServerMessage::LiveState { .. }
    ));
    let MicKey::Phone { phone_id } = phone_key() else {
        unreachable!()
    };
    phone
        .send(&ClientMessage::Join {
            phone_id: PhoneId(phone_id),
            join_code: code.clone(),
            join_as: JoinAs::Guest(NewGuest {
                name: "Guest".into(),
                colour: PaletteKey::Sky,
                avatar: Avatar::BuiltIn {
                    key: AvatarKey::Star,
                },
            }),
        })
        .await;
    match recv(&mut phone).await {
        ServerMessage::PhoneStatus { member_id: Some(_) } => phone,
        other => panic!("expected the Phone's status, got {other:?}"),
    }
}

/// A Stage-browser Local mic of device `device`, channel 0.
fn browser_mic(device: &str) -> (String, LocalMicSource) {
    (
        format!("browser:stage-1:{device}:0"),
        LocalMicSource::Browser {
            stage_browser: "stage-1".into(),
            device_id: device.into(),
            label: "USB Audio".into(),
            channel: 0,
            stereo: false,
        },
    )
}

fn bridge_mic(bridge_id: &BridgeId, channel: u32) -> (String, LocalMicSource) {
    (
        bridge_local_mic_id(bridge_id, DEVICE, channel),
        LocalMicSource::Bridge {
            bridge_id: bridge_id.clone(),
            device_name: DEVICE.into(),
            label: DEVICE.into(),
            channel,
            loopback: None,
        },
    )
}

/// Switches Local mic `mic` on and waits until the Party lists it.
async fn switch_on(stage: &mut WsClient, (id, source): &(String, LocalMicSource)) {
    stage
        .send(&ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: id.clone(),
            source: source.clone(),
            switched_on: true,
        })
        .await;
    party_until(stage, |party| {
        party.local_mics.iter().any(|m| &m.local_mic_id == id)
    })
    .await;
}

fn hello(token: Option<String>) -> ClientMessage {
    ClientMessage::BridgeHello {
        build: openstar::BUILD_ID.into(),
        host_name: "hermes".into(),
        token,
        interfaces: vec![BridgeInterface {
            device_name: DEVICE.into(),
            label: DEVICE.into(),
            channels: 2,
            usb_id: None,
            twin: false,
        }],
    }
}

/// The next message to a bridge past the notices about anything else.
async fn bridge_recv(bridge: &mut WsClient) -> ServerMessage {
    loop {
        match bridge.recv().await {
            ServerMessage::Changed { .. }
            | ServerMessage::PartyChanged { .. }
            | ServerMessage::Calibration { .. }
            | ServerMessage::Volume { .. }
            | ServerMessage::BridgeMicsScreen { .. }
            | ServerMessage::BridgeChannels { .. } => {}
            message => return message,
        }
    }
}

/// An approved, connected bridge: its socket and id.
async fn approved_bridge(app: &TestApp, stage: &mut WsClient) -> (WsClient, BridgeId) {
    let mut bridge = app.connect_ws_at("/ws/bridge").await;
    assert!(matches!(
        bridge.recv().await,
        ServerMessage::LiveState { .. }
    ));
    bridge.send(&hello(None)).await;
    let waiting = bridge_recv(&mut bridge).await;
    assert!(
        matches!(waiting, ServerMessage::BridgeWaiting { .. }),
        "{waiting:?}"
    );
    let listing: MicBridges = app.get_json("/api/mic-bridges").await;
    stage
        .send(&ClientMessage::ApproveBridge {
            request_id: listing.requests[0].request_id,
        })
        .await;
    let ServerMessage::BridgeApproved { .. } = bridge_recv(&mut bridge).await else {
        panic!("expected BridgeApproved");
    };
    let ServerMessage::BridgeConnected { bridge_id } = bridge_recv(&mut bridge).await else {
        panic!("expected BridgeConnected");
    };
    (bridge, bridge_id)
}

/// Every Mic's values at the speakers.
async fn stored(app: &TestApp) -> Vec<MicSettingsEntry> {
    let body: StageOutputMicSettings = app
        .get_json("/api/mic-settings?stageOutput=Built-in%20Audio%20Analog%20Stereo")
        .await;
    body.mics
}

fn local_success(id: &str, delay: f64, bleed: f64) -> CalibrationResult {
    CalibrationResult {
        mic: local(id),
        mic_delay_ms: delay,
        bleed_level_dbfs: bleed,
        mic_threshold_dbfs: Some(bleed + 6.0),
    }
}

#[tokio::test]
async fn the_checklist_lists_switched_on_local_mics_unticked_after_the_phones() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let _phone = joined_phone(&app, &code).await;
    let red = browser_mic("red");
    let blue = browser_mic("blue");
    switch_on(&mut stage, &red).await;
    switch_on(&mut stage, &blue).await;
    // Switched off again: not listed.
    let off = browser_mic("off");
    switch_on(&mut stage, &off).await;
    stage
        .send(&ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: off.0.clone(),
            source: off.1.clone(),
            switched_on: false,
        })
        .await;
    let party = party_until(&mut stage, |party| {
        !party.local_mics.iter().any(|m| m.local_mic_id == off.0)
    })
    .await;
    let order: Vec<String> = party
        .local_mics
        .iter()
        .map(|m| m.local_mic_id.clone())
        .collect();
    assert_eq!(order.len(), 2);

    stage.send(&ClientMessage::OpenCalibration).await;
    let mut expected = vec![entry(phone_key(), true, false)];
    expected.extend(order.iter().map(|id| entry(local(id), false, false)));
    assert_eq!(
        run(&mut stage).await,
        at(CalibrationPhase::Choosing, expected)
    );

    // Ticking one includes it; Continue drops the rest.
    stage
        .send(&ClientMessage::ChooseCalibrationMic {
            mic: local(&red.0),
            chosen: true,
        })
        .await;
    run(&mut stage).await;
    stage
        .send(&ClientMessage::ChooseCalibrationMic {
            mic: phone_key(),
            chosen: false,
        })
        .await;
    run(&mut stage).await;
    stage.send(&ClientMessage::StartCalibration).await;
    assert_eq!(
        run(&mut stage).await,
        at(
            CalibrationPhase::Waiting,
            vec![entry(local(&red.0), true, false)]
        )
    );
}

#[tokio::test]
async fn a_stage_browser_local_mic_is_ready_once_its_device_is_open() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut phone = joined_phone(&app, &code).await;
    let red = browser_mic("red");
    switch_on(&mut stage, &red).await;
    stage
        .send(&ClientMessage::OpenCalibrationFor { mic: local(&red.0) })
        .await;
    comes_to(
        &mut stage,
        &at(
            CalibrationPhase::Choosing,
            vec![
                entry(phone_key(), true, false),
                entry(local(&red.0), true, false),
            ],
        ),
    )
    .await;
    stage.send(&ClientMessage::StartCalibration).await;
    // Its device is not open yet: waiting.
    let waiting = at(
        CalibrationPhase::Waiting,
        vec![
            entry(phone_key(), true, false),
            entry(local(&red.0), true, false),
        ],
    );
    assert_eq!(run(&mut stage).await, waiting);
    comes_to(&mut phone, &waiting).await;

    // The Stage reports its device open: ready.
    stage
        .send(&ClientMessage::ReportCapturingLocalMics {
            local_mic_ids: vec![red.0.clone()],
        })
        .await;
    assert_eq!(
        run(&mut stage).await,
        at(
            CalibrationPhase::Waiting,
            vec![
                entry(phone_key(), true, false),
                entry(local(&red.0), true, true),
            ],
        )
    );
    // The Phone is the last one ready: the tones start.
    phone.send(&ClientMessage::CalibrationListening).await;
    assert_eq!(
        run(&mut stage).await,
        at(
            CalibrationPhase::Tones,
            vec![
                entry(phone_key(), true, true),
                entry(local(&red.0), true, true),
            ],
        )
    );
    // Only the active Stage reports what it captures.
    assert_eq!(
        refused(
            &mut phone,
            ClientMessage::ReportCapturingLocalMics {
                local_mic_ids: vec![]
            }
        )
        .await,
        UserMessage::NotTheStage
    );
}

#[tokio::test]
async fn a_bridge_local_mic_is_ready_while_its_bridge_is_connected_and_detects_for_the_run() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut phone = joined_phone(&app, &code).await;
    let (mut bridge, bridge_id) = approved_bridge(&app, &mut stage).await;
    let mic = bridge_mic(&bridge_id, 1);
    switch_on(&mut stage, &mic).await;

    // Unseated, with no Song: nothing detects yet.
    stage
        .send(&ClientMessage::OpenCalibrationFor { mic: local(&mic.0) })
        .await;
    comes_to(
        &mut stage,
        &at(
            CalibrationPhase::Choosing,
            vec![
                entry(phone_key(), true, false),
                entry(local(&mic.0), true, false),
            ],
        ),
    )
    .await;
    stage.send(&ClientMessage::StartCalibration).await;
    // Its bridge is connected: ready at once; the Phone still waits.
    assert_eq!(
        run(&mut stage).await,
        at(
            CalibrationPhase::Waiting,
            vec![
                entry(phone_key(), true, false),
                entry(local(&mic.0), true, true),
            ],
        )
    );
    // The bridge is told its channel takes part.
    assert_eq!(
        bridge_recv(&mut bridge).await,
        ServerMessage::BridgeDetecting {
            channels: vec![BridgeInput {
                device_name: DEVICE.into(),
                channel: 1,
            }],
        }
    );

    // Its bridge closes: waiting again.
    drop(bridge);
    comes_to(
        &mut stage,
        &at(
            CalibrationPhase::Waiting,
            vec![
                entry(phone_key(), true, false),
                entry(local(&mic.0), true, false),
            ],
        ),
    )
    .await;
    phone.send(&ClientMessage::CalibrationListening).await;
    run(&mut stage).await;
    // Go leaves out the Local mic that is not ready.
    stage.send(&ClientMessage::CalibrationGo).await;
    assert_eq!(
        run(&mut stage).await,
        at(
            CalibrationPhase::Tones,
            vec![entry(phone_key(), true, true)]
        )
    );
}

#[tokio::test]
async fn the_bridge_stops_detecting_when_the_run_ends() {
    let app = TestApp::start().await;
    let (mut stage, _code) = open_stage(&app).await;
    let (mut bridge, bridge_id) = approved_bridge(&app, &mut stage).await;
    let mic = bridge_mic(&bridge_id, 0);
    switch_on(&mut stage, &mic).await;
    stage
        .send(&ClientMessage::CalibrateLocalMicNow {
            local_mic_id: mic.0.clone(),
        })
        .await;
    // Its only Mic is ready: straight to the tones.
    comes_to(
        &mut stage,
        &at(
            CalibrationPhase::Tones,
            vec![entry(local(&mic.0), true, true)],
        ),
    )
    .await;
    assert_eq!(
        bridge_recv(&mut bridge).await,
        ServerMessage::BridgeDetecting {
            channels: vec![BridgeInput {
                device_name: DEVICE.into(),
                channel: 0,
            }],
        }
    );
    stage.send(&ClientMessage::EndCalibration).await;
    assert_eq!(
        bridge_recv(&mut bridge).await,
        ServerMessage::BridgeDetecting { channels: vec![] }
    );
}

#[tokio::test]
async fn a_successful_local_mic_stores_its_threshold_set_by_calibration_and_a_failed_one_nothing() {
    let app = TestApp::start().await;
    let (mut stage, _code) = open_stage(&app).await;
    let red = browser_mic("red");
    let blue = browser_mic("blue");
    switch_on(&mut stage, &red).await;
    switch_on(&mut stage, &blue).await;
    stage
        .send(&ClientMessage::ReportCapturingLocalMics {
            local_mic_ids: vec![red.0.clone(), blue.0.clone()],
        })
        .await;
    // Red's threshold was set by hand before.
    stage
        .send(&ClientMessage::SetMicThreshold {
            stage_output: SPEAKERS.into(),
            local_mic_id: red.0.clone(),
            reference_dbfs: -20.0,
        })
        .await;

    stage.send(&ClientMessage::OpenCalibration).await;
    run(&mut stage).await;
    for id in [&red.0, &blue.0] {
        stage
            .send(&ClientMessage::ChooseCalibrationMic {
                mic: local(id),
                chosen: true,
            })
            .await;
        run(&mut stage).await;
    }
    stage.send(&ClientMessage::StartCalibration).await;
    let tones = run(&mut stage).await.unwrap();
    assert_eq!(tones.phase, CalibrationPhase::Tones);

    stage
        .send(&ClientMessage::FinishCalibration {
            results: vec![local_success(&red.0, 12.0, -48.0)],
        })
        .await;
    let results = run(&mut stage).await.unwrap();
    assert_eq!(results.phase, CalibrationPhase::Results);
    let outcome = |id: &str| {
        results
            .mics
            .iter()
            .find(|m| m.mic == local(id))
            .and_then(|m| m.outcome)
    };
    assert_eq!(
        outcome(&red.0),
        Some(CalibrationOutcome::Calibrated { mic_delay_ms: 12.0 })
    );
    assert_eq!(outcome(&blue.0), Some(CalibrationOutcome::Failed));

    assert_eq!(
        stored(&app).await,
        vec![MicSettingsEntry {
            mic: local(&red.0),
            settings: StoredMicSettings {
                calibration: Some(StoredCalibration {
                    mic_delay_ms: 12.0,
                    bleed_level_dbfs: -48.0,
                }),
                mic_threshold: Some(StoredMicThreshold {
                    reference_dbfs: -42.0,
                    set_by: ThresholdSetBy::Calibration,
                }),
            },
        }]
    );
}

#[tokio::test]
async fn calibrate_this_mic_now_runs_that_local_mic_alone_and_later_runs_start_it_unticked() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut phone = joined_phone(&app, &code).await;
    let red = browser_mic("red");
    switch_on(&mut stage, &red).await;

    stage
        .send(&ClientMessage::CalibrateLocalMicNow {
            local_mic_id: red.0.clone(),
        })
        .await;
    // Past the checklist, with only that Local mic; its device is not open.
    let waiting = at(
        CalibrationPhase::Waiting,
        vec![entry(local(&red.0), true, false)],
    );
    assert_eq!(run(&mut stage).await, waiting);
    comes_to(&mut phone, &waiting).await;
    // While a run is open it cannot start another.
    assert_eq!(
        refused(
            &mut stage,
            ClientMessage::CalibrateLocalMicNow {
                local_mic_id: red.0.clone()
            }
        )
        .await,
        UserMessage::CalibrationRunning
    );
    stage
        .send(&ClientMessage::ReportCapturingLocalMics {
            local_mic_ids: vec![red.0.clone()],
        })
        .await;
    assert_eq!(
        run(&mut stage).await,
        at(
            CalibrationPhase::Tones,
            vec![entry(local(&red.0), true, true)]
        )
    );
    stage.send(&ClientMessage::EndCalibration).await;
    comes_to(&mut stage, &None).await;

    // A later Calibrate mics starts it unticked.
    stage.send(&ClientMessage::OpenCalibration).await;
    assert_eq!(
        run(&mut stage).await,
        at(
            CalibrationPhase::Choosing,
            vec![
                entry(phone_key(), true, false),
                entry(local(&red.0), false, false),
            ],
        )
    );
    stage.send(&ClientMessage::EndCalibration).await;
    comes_to(&mut stage, &None).await;

    // A Local mic that is not switched on cannot be calibrated now.
    assert_eq!(
        refused(
            &mut stage,
            ClientMessage::CalibrateLocalMicNow {
                local_mic_id: "browser:stage-1:nothing:0".into()
            }
        )
        .await,
        UserMessage::InvalidMessage
    );
}
