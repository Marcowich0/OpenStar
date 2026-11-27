//! The OpenStar volume kept per (Stage browser, Stage output), over the real
//! app: the Stage reports its output, the Stage and any Remote step the
//! volume with no Admin PIN, every browser hears the value, and what is kept
//! survives a restart.

use openstar_protocol::profile::{Avatar, AvatarKey, PaletteKey};
use openstar_protocol::volume::VolumeStep;
use openstar_protocol::{
    ClientMessage, JoinAs, JoinCode, NewGuest, PhoneId, ServerMessage, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

/// The next message on `socket`, past change notices and Party changes.
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. } | ServerMessage::PartyChanged { .. } => {}
            message => return message,
        }
    }
}

fn volume(volume: u8, stepped: bool) -> ServerMessage {
    ServerMessage::Volume { volume, stepped }
}

/// Opens the Stage, past its live state, and returns it with the Join code.
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
    (stage, code.unwrap())
}

async fn report(stage: &mut WsClient, browser: &str, output: &str) {
    stage
        .send(&ClientMessage::ReportStageOutput {
            stage_browser: browser.into(),
            stage_output: output.into(),
        })
        .await;
}

async fn step(socket: &mut WsClient, step: VolumeStep) {
    socket.send(&ClientMessage::StepVolume { step }).await;
}

/// A Phone joined to the Party as a Guest, past its own status.
async fn joined_phone(app: &TestApp, code: &JoinCode) -> WsClient {
    let mut phone = app.connect_ws().await;
    assert!(matches!(
        recv(&mut phone).await,
        ServerMessage::LiveState { .. }
    ));
    phone
        .send(&ClientMessage::Join {
            phone_id: PhoneId("4b1d8f0e-0000-4000-8000-000000000001".into()),
            join_code: code.clone(),
            join_as: JoinAs::Guest(NewGuest {
                name: "Bo".into(),
                colour: PaletteKey::Sky,
                avatar: Avatar::BuiltIn {
                    key: AvatarKey::Star,
                },
            }),
        })
        .await;
    loop {
        match recv(&mut phone).await {
            ServerMessage::Volume { .. } => {}
            ServerMessage::PhoneStatus { member_id: Some(_) } => return phone,
            other => panic!("expected the Phone's status, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn an_unknown_output_starts_at_80_and_steps_are_kept_per_browser_and_output() {
    let mut app = TestApp::start().await;
    let (mut stage, _) = open_stage(&app).await;

    report(&mut stage, "stage-1", "Speakers (Scarlett 4i4)").await;
    assert_eq!(recv(&mut stage).await, volume(80, false));
    step(&mut stage, VolumeStep::Up).await;
    assert_eq!(recv(&mut stage).await, volume(85, true));

    // Another output of the same browser keeps its own value.
    report(&mut stage, "stage-1", "HDMI (LG TV)").await;
    assert_eq!(recv(&mut stage).await, volume(80, false));
    step(&mut stage, VolumeStep::Down).await;
    step(&mut stage, VolumeStep::Down).await;
    assert_eq!(recv(&mut stage).await, volume(75, true));
    assert_eq!(recv(&mut stage).await, volume(70, true));

    // The same output name in another browser is another Stage output.
    report(&mut stage, "stage-2", "Speakers (Scarlett 4i4)").await;
    assert_eq!(recv(&mut stage).await, volume(80, false));

    // Switching back finds the stored value.
    report(&mut stage, "stage-1", "Speakers (Scarlett 4i4)").await;
    assert_eq!(recv(&mut stage).await, volume(85, false));

    drop(stage);
    app.restart().await;
    let (mut stage, _) = open_stage(&app).await;
    report(&mut stage, "stage-1", "HDMI (LG TV)").await;
    assert_eq!(recv(&mut stage).await, volume(70, false));
    report(&mut stage, "stage-1", "Speakers (Scarlett 4i4)").await;
    assert_eq!(recv(&mut stage).await, volume(85, false));
}

#[tokio::test]
async fn a_joined_remote_steps_the_volume_with_no_pin_and_every_browser_hears_it() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    report(&mut stage, "stage-1", "Speakers").await;
    assert_eq!(recv(&mut stage).await, volume(80, false));

    let mut phone = joined_phone(&app, &code).await;
    step(&mut phone, VolumeStep::Up).await;
    assert_eq!(recv(&mut phone).await, volume(85, true));
    assert_eq!(recv(&mut stage).await, volume(85, true));

    // A browser that connects now is told the current value after the
    // live state.
    let mut late = app.connect_ws().await;
    assert!(matches!(
        recv(&mut late).await,
        ServerMessage::LiveState { .. }
    ));
    assert_eq!(recv(&mut late).await, volume(85, false));

    // A Phone that has not joined is not a Remote.
    step(&mut late, VolumeStep::Up).await;
    assert_eq!(
        recv(&mut late).await,
        ServerMessage::Rejected {
            reason: UserMessage::NotInParty
        }
    );
}

#[tokio::test]
async fn only_the_stage_reports_its_output_and_no_step_lands_before_it_has() {
    let app = TestApp::start().await;
    let (mut stage, _) = open_stage(&app).await;

    step(&mut stage, VolumeStep::Up).await;
    assert_eq!(
        recv(&mut stage).await,
        ServerMessage::Rejected {
            reason: UserMessage::NoStage
        }
    );

    let mut other = app.connect_ws().await;
    assert!(matches!(
        recv(&mut other).await,
        ServerMessage::LiveState { .. }
    ));
    report(&mut other, "elsewhere", "Speakers").await;
    assert_eq!(
        recv(&mut other).await,
        ServerMessage::Rejected {
            reason: UserMessage::NotTheStage
        }
    );
}

#[tokio::test]
async fn the_output_is_forgotten_when_the_stage_closes() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    report(&mut stage, "stage-1", "Speakers").await;
    assert_eq!(recv(&mut stage).await, volume(80, false));
    let mut phone = joined_phone(&app, &code).await;

    drop(stage);
    // The server sees the Stage go some time after the drop: step until it
    // refuses.
    for _ in 0..100 {
        step(&mut phone, VolumeStep::Up).await;
        match recv(&mut phone).await {
            ServerMessage::Volume { stepped: true, .. } => {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            ServerMessage::Rejected {
                reason: UserMessage::NoStage,
            } => return,
            other => panic!("expected a step or its refusal, got {other:?}"),
        }
    }
    panic!("the Stage's output outlived the Stage");
}
