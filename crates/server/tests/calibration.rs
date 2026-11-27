//! Calibrate mics over the real app (#170): the run is held by the server
//! and told to every connection. The checklist lists every joined Phone,
//! ticked; Continue asks the chosen Mics to listen; a Phone is ready after
//! "I'm listening" (driven here by a test Phone client); the tones start when
//! every chosen Mic is ready or on Go; the Stage's analysis stores only the
//! successes, against the Stage output in effect when the run started.

use std::path::Path;

use openstar_protocol::library::SongList;
use openstar_protocol::mics::{
    CalibrationMic, CalibrationOutcome, CalibrationPhase, CalibrationResult, CalibrationRun,
    MicKey, MicSettingsEntry, StageOutputMicSettings, StoredCalibration, StoredMicSettings,
};
use openstar_protocol::profile::{Avatar, AvatarKey, PaletteKey};
use openstar_protocol::{
    ClientMessage, JoinAs, JoinCode, NewGuest, PhoneId, ServerMessage, SongControl, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

const SPEAKERS: &str = "Built-in Audio Analog Stereo";
const TV: &str = "HDMI / DisplayPort 1 Output";

fn phone_id(n: u8) -> String {
    format!("4b1d8f0e-0000-4000-8000-0000000000{n:02}")
}

fn key(n: u8) -> MicKey {
    MicKey::Phone {
        phone_id: phone_id(n),
    }
}

/// The next message on `socket`, past change notices, Party changes and
/// volume reports.
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. }
            | ServerMessage::PartyChanged { .. }
            | ServerMessage::Volume { .. } => {}
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

/// Nothing more was sent to `socket`: a Ping is answered next.
async fn hears_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 77 });
}

async fn refused(socket: &mut WsClient, message: ClientMessage) -> UserMessage {
    socket.send(&message).await;
    match recv(socket).await {
        ServerMessage::Rejected { reason } => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn mic(n: u8, chosen: bool, ready: bool) -> CalibrationMic {
    CalibrationMic {
        mic: key(n),
        chosen,
        ready,
        outcome: None,
    }
}

fn at(phase: CalibrationPhase, mics: Vec<CalibrationMic>) -> Option<CalibrationRun> {
    Some(CalibrationRun { phase, mics })
}

/// Opens the Stage, past its live state, reports its output and returns it
/// with the Join code.
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
    report_output(&mut stage, SPEAKERS).await;
    (stage, code.unwrap())
}

async fn report_output(stage: &mut WsClient, output: &str) {
    stage
        .send(&ClientMessage::ReportStageOutput {
            stage_browser: "stage-browser-1".into(),
            stage_output: output.into(),
        })
        .await;
    loop {
        if let ServerMessage::Volume { .. } = stage.recv().await {
            break;
        }
    }
}

/// Phone `n` joined to the Party as a Guest, past its own status.
async fn joined_phone(app: &TestApp, code: &JoinCode, n: u8) -> WsClient {
    let mut phone = app.connect_ws().await;
    assert!(matches!(
        recv(&mut phone).await,
        ServerMessage::LiveState { .. }
    ));
    phone
        .send(&ClientMessage::Join {
            phone_id: PhoneId(phone_id(n)),
            join_code: code.clone(),
            join_as: JoinAs::Guest(NewGuest {
                name: format!("Guest {n}"),
                colour: [PaletteKey::Sky, PaletteKey::Teal, PaletteKey::Lime][usize::from(n % 3)],
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

/// Every Mic's values at `output`.
async fn stored(app: &TestApp, output: &str) -> Vec<MicSettingsEntry> {
    let body: StageOutputMicSettings = app
        .http()
        .get(app.url(&format!(
            "/api/mic-settings?stageOutput={}",
            percent_encode(output)
        )))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    body.mics
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

fn calibrated(delay: f64, bleed: f64) -> StoredMicSettings {
    StoredMicSettings {
        calibration: Some(StoredCalibration {
            mic_delay_ms: delay,
            bleed_level_dbfs: bleed,
        }),
        mic_threshold: None,
    }
}

fn success(n: u8, delay: f64, bleed: f64) -> CalibrationResult {
    CalibrationResult {
        mic: key(n),
        mic_delay_ms: delay,
        bleed_level_dbfs: bleed,
        mic_threshold_dbfs: None,
    }
}

/// `socket` hears runs until `expected`, the latest.
async fn comes_to(socket: &mut WsClient, expected: &Option<CalibrationRun>) {
    while &run(socket).await != expected {}
}

/// Every socket hears the same run next.
async fn all_hear(sockets: &mut [&mut WsClient], expected: &Option<CalibrationRun>) {
    for socket in sockets {
        assert_eq!(&run(socket).await, expected);
    }
}

#[tokio::test]
async fn the_checklist_ticks_every_joined_phone_and_needs_one_to_continue() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut one = joined_phone(&app, &code, 1).await;
    let mut two = joined_phone(&app, &code, 2).await;

    // The Stage opens it with no Admin PIN; every browser hears it.
    stage.send(&ClientMessage::OpenCalibration).await;
    let checklist = at(
        CalibrationPhase::Choosing,
        vec![mic(1, true, false), mic(2, true, false)],
    );
    all_hear(&mut [&mut stage, &mut one, &mut two], &checklist).await;

    // A browser that connects now is told after its live state.
    let mut late = app.connect_ws().await;
    assert!(matches!(
        recv(&mut late).await,
        ServerMessage::LiveState { .. }
    ));
    assert_eq!(run(&mut late).await, checklist);

    // Opening it again changes nothing.
    stage.send(&ClientMessage::OpenCalibration).await;
    hears_nothing(&mut stage).await;

    // Untick both: it cannot continue. Tick one again.
    for n in [1, 2] {
        stage
            .send(&ClientMessage::ChooseCalibrationMic {
                mic: key(n),
                chosen: false,
            })
            .await;
        run(&mut stage).await;
    }
    assert_eq!(
        refused(&mut stage, ClientMessage::StartCalibration).await,
        UserMessage::NoMicsChosen
    );
    stage
        .send(&ClientMessage::ChooseCalibrationMic {
            mic: key(2),
            chosen: true,
        })
        .await;
    assert_eq!(
        run(&mut stage).await,
        at(
            CalibrationPhase::Choosing,
            vec![mic(1, false, false), mic(2, true, false)]
        )
    );
    // A Mic the checklist does not list cannot be ticked.
    assert_eq!(
        refused(
            &mut stage,
            ClientMessage::ChooseCalibrationMic {
                mic: key(9),
                chosen: true
            }
        )
        .await,
        UserMessage::InvalidMessage
    );

    // Cancel closes it for every browser.
    stage.send(&ClientMessage::EndCalibration).await;
    for socket in [&mut stage, &mut one, &mut late] {
        comes_to(socket, &None).await;
    }
}

#[tokio::test]
async fn a_remote_starts_ticks_and_goes_in_the_one_run_the_stage_shows() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut one = joined_phone(&app, &code, 1).await;
    let mut two = joined_phone(&app, &code, 2).await;

    // Phone 1's Remote presses Calibrate mics, with no Admin PIN: the
    // Stage and every Phone hear the checklist.
    one.send(&ClientMessage::OpenCalibration).await;
    let checklist = at(
        CalibrationPhase::Choosing,
        vec![mic(1, true, false), mic(2, true, false)],
    );
    all_hear(&mut [&mut stage, &mut one, &mut two], &checklist).await;

    // Phone 2's Remote presses it too: it joins that run, nothing changes.
    two.send(&ClientMessage::OpenCalibration).await;
    hears_nothing(&mut two).await;
    hears_nothing(&mut stage).await;

    // A tick from the Remote and one from the Stage land in the same run.
    one.send(&ClientMessage::ChooseCalibrationMic {
        mic: key(2),
        chosen: false,
    })
    .await;
    let unticked = at(
        CalibrationPhase::Choosing,
        vec![mic(1, true, false), mic(2, false, false)],
    );
    all_hear(&mut [&mut stage, &mut one, &mut two], &unticked).await;
    stage
        .send(&ClientMessage::ChooseCalibrationMic {
            mic: key(2),
            chosen: true,
        })
        .await;
    all_hear(&mut [&mut stage, &mut one, &mut two], &checklist).await;

    // Continue from Phone 2's Remote; Phone 1 is ready; Go from Phone 2's
    // Remote starts the tones without it.
    two.send(&ClientMessage::StartCalibration).await;
    let waiting = at(
        CalibrationPhase::Waiting,
        vec![mic(1, true, false), mic(2, true, false)],
    );
    all_hear(&mut [&mut stage, &mut one, &mut two], &waiting).await;
    one.send(&ClientMessage::CalibrationListening).await;
    let one_ready = at(
        CalibrationPhase::Waiting,
        vec![mic(1, true, true), mic(2, true, false)],
    );
    all_hear(&mut [&mut stage, &mut one, &mut two], &one_ready).await;
    two.send(&ClientMessage::CalibrationGo).await;
    let tones = at(CalibrationPhase::Tones, vec![mic(1, true, true)]);
    all_hear(&mut [&mut stage, &mut one, &mut two], &tones).await;

    // The results reach the Remotes too, and Done there closes them.
    stage
        .send(&ClientMessage::FinishCalibration {
            results: vec![success(1, 98.0, -40.0)],
        })
        .await;
    let results = at(
        CalibrationPhase::Results,
        vec![CalibrationMic {
            outcome: Some(CalibrationOutcome::Calibrated { mic_delay_ms: 98.0 }),
            ..mic(1, true, true)
        }],
    );
    all_hear(&mut [&mut stage, &mut one, &mut two], &results).await;
    two.send(&ClientMessage::EndCalibration).await;
    all_hear(&mut [&mut stage, &mut one, &mut two], &None).await;
}

#[tokio::test]
async fn the_tones_start_by_themselves_once_every_chosen_mic_is_ready() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut one = joined_phone(&app, &code, 1).await;
    let mut two = joined_phone(&app, &code, 2).await;
    let mut three = joined_phone(&app, &code, 3).await;

    stage.send(&ClientMessage::OpenCalibration).await;
    run(&mut stage).await;
    stage
        .send(&ClientMessage::ChooseCalibrationMic {
            mic: key(3),
            chosen: false,
        })
        .await;
    run(&mut stage).await;
    stage.send(&ClientMessage::StartCalibration).await;
    assert_eq!(
        run(&mut stage).await,
        at(
            CalibrationPhase::Waiting,
            vec![mic(1, true, false), mic(2, true, false)]
        )
    );
    for socket in [&mut one, &mut two, &mut three] {
        run(socket).await; // the checklist
        run(socket).await; // its untick
        run(socket).await; // waiting
    }

    // An unchosen Phone's tap is refused.
    assert_eq!(
        refused(&mut three, ClientMessage::CalibrationListening).await,
        UserMessage::NotInCalibration
    );

    one.send(&ClientMessage::CalibrationListening).await;
    let one_ready = at(
        CalibrationPhase::Waiting,
        vec![mic(1, true, true), mic(2, true, false)],
    );
    all_hear(&mut [&mut stage, &mut one, &mut two], &one_ready).await;

    two.send(&ClientMessage::CalibrationListening).await;
    let tones = at(
        CalibrationPhase::Tones,
        vec![mic(1, true, true), mic(2, true, true)],
    );
    all_hear(&mut [&mut stage, &mut one, &mut two], &tones).await;

    // Too late to tap now.
    assert_eq!(
        refused(&mut two, ClientMessage::CalibrationListening).await,
        UserMessage::CalibrationNotRunning
    );
}

#[tokio::test]
async fn go_leaves_out_the_mics_not_ready_and_they_keep_their_values() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut one = joined_phone(&app, &code, 1).await;
    let _two = joined_phone(&app, &code, 2).await;

    // Phone 2 was calibrated before.
    stage
        .send(&ClientMessage::StoreCalibration {
            stage_output: SPEAKERS.into(),
            results: vec![success(2, 140.0, -40.0)],
        })
        .await;

    stage.send(&ClientMessage::OpenCalibration).await;
    run(&mut stage).await;
    stage.send(&ClientMessage::StartCalibration).await;
    run(&mut stage).await;

    // Go with no Mic ready has nothing to measure.
    assert_eq!(
        refused(&mut stage, ClientMessage::CalibrationGo).await,
        UserMessage::NoMicReady
    );

    one.send(&ClientMessage::CalibrationListening).await;
    run(&mut stage).await;
    stage.send(&ClientMessage::CalibrationGo).await;
    assert_eq!(
        run(&mut stage).await,
        at(CalibrationPhase::Tones, vec![mic(1, true, true)])
    );

    // Phone 2 takes no part: a result for it is not stored.
    stage
        .send(&ClientMessage::FinishCalibration {
            results: vec![success(1, 102.4, -38.0), success(2, 90.0, -30.0)],
        })
        .await;
    assert_eq!(
        refused_or_run(&mut stage).await,
        Err(UserMessage::InvalidMessage)
    );
    stage
        .send(&ClientMessage::FinishCalibration {
            results: vec![success(1, 102.4, -38.0)],
        })
        .await;
    assert_eq!(
        run(&mut stage).await,
        at(
            CalibrationPhase::Results,
            vec![CalibrationMic {
                outcome: Some(CalibrationOutcome::Calibrated {
                    mic_delay_ms: 102.4
                }),
                ..mic(1, true, true)
            }]
        )
    );

    let mut values = stored(&app, SPEAKERS).await;
    values.sort_by_key(|entry| format!("{:?}", entry.mic));
    assert_eq!(
        values,
        vec![
            MicSettingsEntry {
                mic: key(1),
                settings: calibrated(102.4, -38.0),
            },
            MicSettingsEntry {
                mic: key(2),
                settings: calibrated(140.0, -40.0),
            },
        ]
    );

    // Done closes the results.
    stage.send(&ClientMessage::EndCalibration).await;
    assert_eq!(run(&mut stage).await, None);
}

async fn refused_or_run(socket: &mut WsClient) -> Result<Option<CalibrationRun>, UserMessage> {
    match recv(socket).await {
        ServerMessage::Rejected { reason } => Err(reason),
        ServerMessage::Calibration { run } => Ok(run),
        other => panic!("expected a refusal or the run, got {other:?}"),
    }
}

#[tokio::test]
async fn only_successes_are_stored_against_the_output_in_effect_when_the_run_started() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut one = joined_phone(&app, &code, 1).await;
    let mut two = joined_phone(&app, &code, 2).await;

    // Phone 2 was calibrated before; its failure keeps that.
    stage
        .send(&ClientMessage::StoreCalibration {
            stage_output: SPEAKERS.into(),
            results: vec![success(2, 140.0, -40.0)],
        })
        .await;

    stage.send(&ClientMessage::OpenCalibration).await;
    run(&mut stage).await;
    stage.send(&ClientMessage::StartCalibration).await;
    run(&mut stage).await;
    one.send(&ClientMessage::CalibrationListening).await;
    run(&mut stage).await;
    two.send(&ClientMessage::CalibrationListening).await;
    run(&mut stage).await; // tones

    // The Stage's output changes during the tones.
    report_output(&mut stage, TV).await;

    // A Phone cannot report results.
    comes_to(
        &mut one,
        &at(
            CalibrationPhase::Tones,
            vec![mic(1, true, true), mic(2, true, true)],
        ),
    )
    .await;
    assert_eq!(
        refused(
            &mut one,
            ClientMessage::FinishCalibration {
                results: vec![success(1, 1.0, -1.0)]
            }
        )
        .await,
        UserMessage::NotTheStage
    );

    stage
        .send(&ClientMessage::FinishCalibration {
            results: vec![success(1, 101.6, -37.5)],
        })
        .await;
    let results = at(
        CalibrationPhase::Results,
        vec![
            CalibrationMic {
                outcome: Some(CalibrationOutcome::Calibrated {
                    mic_delay_ms: 101.6,
                }),
                ..mic(1, true, true)
            },
            CalibrationMic {
                outcome: Some(CalibrationOutcome::Failed),
                ..mic(2, true, true)
            },
        ],
    );
    assert_eq!(run(&mut stage).await, results);
    for socket in [&mut one, &mut two] {
        comes_to(socket, &results).await;
    }

    let mut values = stored(&app, SPEAKERS).await;
    values.sort_by_key(|entry| format!("{:?}", entry.mic));
    assert_eq!(
        values,
        vec![
            MicSettingsEntry {
                mic: key(1),
                settings: calibrated(101.6, -37.5),
            },
            MicSettingsEntry {
                mic: key(2),
                settings: calibrated(140.0, -40.0),
            },
        ]
    );
    assert_eq!(stored(&app, TV).await, vec![]);

    // The results are reported once.
    assert_eq!(
        refused(
            &mut stage,
            ClientMessage::FinishCalibration { results: vec![] }
        )
        .await,
        UserMessage::CalibrationNotRunning
    );
}

#[tokio::test]
async fn cancel_before_the_tones_and_a_stage_drop_end_the_run_with_nothing_stored() {
    let mut app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut one = joined_phone(&app, &code, 1).await;

    // Cancel while waiting, from the Stage.
    stage.send(&ClientMessage::OpenCalibration).await;
    run(&mut stage).await;
    stage.send(&ClientMessage::StartCalibration).await;
    run(&mut stage).await;
    stage.send(&ClientMessage::EndCalibration).await;
    assert_eq!(run(&mut stage).await, None);
    run(&mut one).await;
    run(&mut one).await;
    assert_eq!(run(&mut one).await, None);
    // Nothing is left to finish.
    assert_eq!(
        refused(
            &mut stage,
            ClientMessage::FinishCalibration {
                results: vec![success(1, 100.0, -40.0)]
            }
        )
        .await,
        UserMessage::CalibrationNotRunning
    );

    // The Stage drops during the tones.
    stage.send(&ClientMessage::OpenCalibration).await;
    run(&mut stage).await;
    stage.send(&ClientMessage::StartCalibration).await;
    run(&mut stage).await;
    one.send(&ClientMessage::CalibrationListening).await;
    run(&mut stage).await;
    for _ in 0..3 {
        run(&mut one).await;
    }
    drop(stage);
    assert_eq!(run(&mut one).await, None);
    assert_eq!(stored(&app, SPEAKERS).await, vec![]);

    // A new Stage finds no run; nor does anyone after a server restart.
    let (mut stage, _) = open_stage(&app).await;
    stage.send(&ClientMessage::OpenCalibration).await;
    assert!(run(&mut stage).await.is_some());
    drop(one);
    app.restart().await;
    let mut after = app.connect_ws().await;
    assert!(matches!(
        recv(&mut after).await,
        ServerMessage::LiveState { .. }
    ));
    hears_nothing(&mut after).await;
}

#[tokio::test]
async fn calibration_and_check_av_sync_never_run_together() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut one = joined_phone(&app, &code, 1).await;

    stage.send(&ClientMessage::StartAvSync).await;
    assert_eq!(
        recv(&mut stage).await,
        ServerMessage::AvSync { running: true }
    );
    assert_eq!(
        refused(&mut stage, ClientMessage::OpenCalibration).await,
        UserMessage::AvSyncRunning
    );
    stage.send(&ClientMessage::EndAvSync).await;
    recv(&mut stage).await;

    // A joined Remote may open it too.
    one.send(&ClientMessage::OpenCalibration).await;
    assert!(run(&mut stage).await.is_some());
    assert_eq!(
        refused(&mut stage, ClientMessage::StartAvSync).await,
        UserMessage::CalibrationRunning
    );
}

fn write_song(folder: &Path, title: &str) {
    std::fs::create_dir_all(folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:Placeholder\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n"),
    )
    .unwrap();
}

#[tokio::test]
async fn it_is_refused_while_a_song_plays_and_ends_when_one_starts() {
    let mut app = TestApp::start().await;
    write_song(&app.songs_dir().join("Solo"), "Solo");
    app.restart().await;
    let solo = app.get_json::<SongList>("/api/songs").await.songs[0].id;
    let (mut stage, code) = open_stage(&app).await;
    let mut phone = joined_phone(&app, &code, 1).await;

    phone
        .send(&ClientMessage::AddRequest {
            song_id: solo,
            requested_players: None,
        })
        .await;
    let request = loop {
        match stage.recv().await {
            ServerMessage::PartyChanged { party, .. } if party.line_up.is_some() => {
                break party.line_up.unwrap().request_id;
            }
            _ => {}
        }
    };
    // A run is open over the waiting Line-up; starting the Song ends it.
    stage.send(&ClientMessage::OpenCalibration).await;
    assert!(run(&mut stage).await.is_some());
    assert!(run(&mut phone).await.is_some());
    phone
        .send(&ClientMessage::ControlSong {
            request_id: request,
            control: SongControl::Start,
        })
        .await;
    assert_eq!(run(&mut phone).await, None);
    loop {
        match recv(&mut stage).await {
            ServerMessage::ControlSong { .. } => {}
            message => {
                assert_eq!(message, ServerMessage::Calibration { run: None });
                break;
            }
        }
    }

    assert_eq!(
        refused(&mut stage, ClientMessage::OpenCalibration).await,
        UserMessage::NotWhileSongPlays
    );
    assert_eq!(
        refused(&mut phone, ClientMessage::OpenCalibration).await,
        UserMessage::NotWhileSongPlays
    );
}
