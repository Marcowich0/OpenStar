//! "Not calibrated" over the real app (#171): a Line-up seat warns when no
//! Mic delay is stored for its Mic at the Stage's current output. A hand-set
//! Mic threshold alone does not count; the warning never blocks Start; it
//! goes after a successful Calibration and comes back when the output
//! changes to one without values for that Mic.

use std::path::Path;

use openstar_protocol::library::{SongId, SongList};
use openstar_protocol::mics::{
    CalibrationMic, CalibrationPhase, CalibrationResult, CalibrationRun, LocalMicSource, MicKey,
};
use openstar_protocol::profile::{Avatar, AvatarKey, PaletteKey};
use openstar_protocol::{
    ClientMessage, JoinAs, JoinCode, LineUp, LineUpEdit, LineUpWarning, NewGuest, PartyMemberId,
    PartySnapshot, PhoneId, ServerMessage,
};
use openstar_test_harness::{TestApp, WsClient};

const SPEAKERS: &str = "Built-in Audio Analog Stereo";
const TV: &str = "HDMI / DisplayPort 1 Output";

fn write_song(folder: &Path) {
    std::fs::create_dir_all(folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        "#ARTIST:Placeholder\n#TITLE:Solo\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n",
    )
    .unwrap();
}

async fn app_with_song() -> (TestApp, SongId) {
    let mut app = TestApp::start().await;
    write_song(&app.songs_dir().join("Solo"));
    app.restart().await;
    let songs = app.get_json::<SongList>("/api/songs").await.songs;
    (app, songs[0].id)
}

fn phone_id(n: u8) -> String {
    format!("4b1d8f0e-0000-4000-8000-0000000000{n:02}")
}

fn phone_mic(n: u8) -> MicKey {
    MicKey::Phone {
        phone_id: phone_id(n),
    }
}

/// The next message on `socket`, past change notices for HTTP data and
/// volume reports.
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. } | ServerMessage::Volume { .. } => {}
            message => return message,
        }
    }
}

/// The Line-up in the next Party change on `socket` that has one.
async fn next_line_up(socket: &mut WsClient) -> LineUp {
    loop {
        if let ServerMessage::PartyChanged {
            party:
                PartySnapshot {
                    line_up: Some(line_up),
                    ..
                },
            ..
        } = recv(socket).await
        {
            return line_up;
        }
    }
}

/// Party changes on `socket` until the Line-up's warnings are `expected`.
async fn warns(socket: &mut WsClient, expected: &[LineUpWarning]) -> LineUp {
    loop {
        let line_up = next_line_up(socket).await;
        if line_up.warnings == expected {
            return line_up;
        }
    }
}

fn not_calibrated(member_id: PartyMemberId) -> LineUpWarning {
    LineUpWarning::NotCalibrated { member_id }
}

async fn open_stage(app: &TestApp) -> (WsClient, JoinCode) {
    let mut stage = app.connect_stage().await;
    let mut code = match recv(&mut stage).await {
        ServerMessage::LiveState {
            is_stage: true,
            party,
            ..
        } => party.map(|party| party.join_code),
        other => panic!("expected the live state first, got {other:?}"),
    };
    if code.is_none() {
        match recv(&mut stage).await {
            ServerMessage::PartyChanged { party, .. } => code = Some(party.join_code),
            other => panic!("expected the first Party, got {other:?}"),
        }
    }
    (stage, code.unwrap())
}

async fn report_output(stage: &mut WsClient, output: &str) {
    stage
        .send(&ClientMessage::ReportStageOutput {
            stage_browser: "stage-browser-1".into(),
            stage_output: output.into(),
        })
        .await;
}

/// Phone `n` joined as a Guest; returns its socket and member id.
async fn joined_phone(app: &TestApp, code: &JoinCode, n: u8) -> (WsClient, PartyMemberId) {
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
    loop {
        if let ServerMessage::PhoneStatus {
            member_id: Some(member_id),
        } = recv(&mut phone).await
        {
            return (phone, member_id);
        }
    }
}

fn success(mic: MicKey) -> CalibrationResult {
    CalibrationResult {
        mic,
        mic_delay_ms: 112.0,
        bleed_level_dbfs: -48.0,
        mic_threshold_dbfs: None,
    }
}

#[tokio::test]
async fn an_uncalibrated_phone_warns_without_blocking_start_until_calibrated_at_this_output() {
    let (app, solo) = app_with_song().await;
    let (mut stage, code) = open_stage(&app).await;
    let (mut phone, member) = joined_phone(&app, &code, 1).await;
    phone
        .send(&ClientMessage::AddRequest {
            song_id: solo,
            requested_players: None,
        })
        .await;

    // No output known yet: nothing to say about calibration.
    let line_up = next_line_up(&mut stage).await;
    assert_eq!(line_up.seats[0].mic, Some(phone_mic(1)));
    assert_eq!(line_up.warnings, vec![]);

    // The Stage reports its output: nothing is stored there.
    report_output(&mut stage, SPEAKERS).await;
    let line_up = warns(&mut stage, &[not_calibrated(member)]).await;
    assert!(line_up.can_start, "Not calibrated never blocks Start");
    warns(&mut phone, &[not_calibrated(member)]).await;

    // A Calibration stored for this Mic at this output: the warning goes.
    stage
        .send(&ClientMessage::StoreCalibration {
            stage_output: SPEAKERS.into(),
            results: vec![success(phone_mic(1))],
        })
        .await;
    warns(&mut stage, &[]).await;
    warns(&mut phone, &[]).await;

    // The output changes to one with no values for it: back again.
    report_output(&mut stage, TV).await;
    warns(&mut stage, &[not_calibrated(member)]).await;
    report_output(&mut stage, SPEAKERS).await;
    warns(&mut stage, &[]).await;
}

#[tokio::test]
async fn a_local_mic_with_only_a_hand_set_threshold_is_not_calibrated() {
    let (app, solo) = app_with_song().await;
    let (mut stage, code) = open_stage(&app).await;
    report_output(&mut stage, SPEAKERS).await;
    let local = "browser:stage-1:usb:0".to_owned();
    stage
        .send(&ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: local.clone(),
            source: LocalMicSource::Browser {
                stage_browser: "stage-1".into(),
                device_id: "usb".into(),
                label: "USB Audio".into(),
                channel: 0,
                stereo: true,
            },
            switched_on: true,
        })
        .await;
    stage
        .send(&ClientMessage::ReportPresentLocalMics {
            local_mic_ids: vec![local.clone()],
        })
        .await;
    stage
        .send(&ClientMessage::SetMicThreshold {
            stage_output: SPEAKERS.into(),
            local_mic_id: local.clone(),
            reference_dbfs: -35.0,
        })
        .await;
    let (mut phone, member) = joined_phone(&app, &code, 1).await;
    phone
        .send(&ClientMessage::AddRequest {
            song_id: solo,
            requested_players: None,
        })
        .await;
    let line_up = warns(&mut phone, &[not_calibrated(member)]).await;
    let local_mic = MicKey::LocalMic {
        local_mic_id: local.clone(),
    };
    assert_eq!(line_up.seats[0].mic, Some(local_mic.clone()));

    // Calibrated at this output: no warning.
    stage
        .send(&ClientMessage::StoreCalibration {
            stage_output: SPEAKERS.into(),
            results: vec![success(local_mic)],
        })
        .await;
    warns(&mut phone, &[]).await;
}

#[tokio::test]
async fn a_successful_run_clears_the_warning_and_a_seat_mic_can_be_ticked_on_opening() {
    let (app, solo) = app_with_song().await;
    let (mut stage, code) = open_stage(&app).await;
    report_output(&mut stage, SPEAKERS).await;
    let (mut one, member_one) = joined_phone(&app, &code, 1).await;
    let (mut two, member_two) = joined_phone(&app, &code, 2).await;
    one.send(&ClientMessage::AddRequest {
        song_id: solo,
        requested_players: None,
    })
    .await;
    let line_up = warns(&mut one, &[not_calibrated(member_one)]).await;
    one.send(&ClientMessage::EditLineUp {
        request_id: line_up.request_id,
        edit: LineUpEdit::AddSeat {
            who: openstar_protocol::SeatWho::Member {
                member_id: member_two,
            },
        },
    })
    .await;
    warns(
        &mut one,
        &[not_calibrated(member_one), not_calibrated(member_two)],
    )
    .await;

    // Calibrate mics from Phone two's seat: opened with the usual ticks
    // (every joined Phone) and that seat's Mic ticked.
    two.send(&ClientMessage::OpenCalibrationFor { mic: phone_mic(2) })
        .await;
    let expected = |n: u8| CalibrationMic {
        mic: phone_mic(n),
        chosen: true,
        ready: false,
        outcome: None,
    };
    loop {
        if let ServerMessage::Calibration { run } = recv(&mut stage).await {
            assert_eq!(
                run,
                Some(CalibrationRun {
                    phase: CalibrationPhase::Choosing,
                    mics: vec![expected(1), expected(2)],
                })
            );
            break;
        }
    }
    // Phone one's Mic is left out; only Phone two runs.
    stage
        .send(&ClientMessage::ChooseCalibrationMic {
            mic: phone_mic(1),
            chosen: false,
        })
        .await;
    stage.send(&ClientMessage::StartCalibration).await;
    loop {
        if let ServerMessage::Calibration {
            run:
                Some(CalibrationRun {
                    phase: CalibrationPhase::Waiting,
                    ..
                }),
        } = recv(&mut two).await
        {
            break;
        }
    }
    two.send(&ClientMessage::CalibrationListening).await;
    loop {
        if let ServerMessage::Calibration {
            run:
                Some(CalibrationRun {
                    phase: CalibrationPhase::Tones,
                    ..
                }),
        } = recv(&mut stage).await
        {
            break;
        }
    }
    stage
        .send(&ClientMessage::FinishCalibration {
            results: vec![success(phone_mic(2))],
        })
        .await;
    warns(&mut one, &[not_calibrated(member_one)]).await;
}

#[tokio::test]
async fn opening_for_a_mic_the_checklist_does_not_list_adds_it_ticked() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    report_output(&mut stage, SPEAKERS).await;
    let (mut one, _) = joined_phone(&app, &code, 1).await;
    let local = MicKey::LocalMic {
        local_mic_id: "browser:stage-1:usb:0".into(),
    };
    one.send(&ClientMessage::OpenCalibration).await;
    // Already open: the seat's Mic is ticked on the open checklist.
    stage
        .send(&ClientMessage::OpenCalibrationFor { mic: local.clone() })
        .await;
    let mut last = None;
    while last
        .as_ref()
        .is_none_or(|run: &CalibrationRun| run.mics.len() < 2)
    {
        if let ServerMessage::Calibration { run } = recv(&mut stage).await {
            last = run;
        }
    }
    let run = last.unwrap();
    assert_eq!(run.phase, CalibrationPhase::Choosing);
    assert_eq!(run.mics[1].mic, local);
    assert!(run.mics[1].chosen);
}
