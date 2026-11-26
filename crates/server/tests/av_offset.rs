//! The A/V offset kept per (browser, output key), over the real app: any
//! browser reads and sets its own value with no Admin PIN, an output with
//! nothing stored reads 0 ms, values outside -300..=500 ms or off the 10 ms
//! grid are refused, and what is kept survives a restart.

use openstar_protocol::av_offset::AvOffset;
use openstar_protocol::volume::VolumeStep;
use openstar_protocol::{ClientMessage, ServerMessage, UserMessage};
use openstar_test_harness::{TestApp, WsClient};
use reqwest::StatusCode;

fn offset(browser: &str, output: &str, av_offset_ms: i32) -> AvOffset {
    AvOffset {
        browser: browser.into(),
        output: output.into(),
        av_offset_ms,
    }
}

async fn read(app: &TestApp, browser: &str, output: &str) -> AvOffset {
    let url = reqwest::Url::parse_with_params(
        &app.url("/api/av-offset"),
        [("browser", browser), ("output", output)],
    )
    .unwrap();
    let path = format!("{}?{}", url.path(), url.query().unwrap());
    app.get_json(&path).await
}

/// PUTs `body` with no Unlock and no Stage cookie, as any browser would.
async fn put(app: &TestApp, body: &AvOffset) -> reqwest::Response {
    app.http()
        .put(app.url("/api/av-offset"))
        .json(body)
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn an_output_with_nothing_stored_reads_zero() {
    let app = TestApp::start().await;
    assert_eq!(
        read(&app, "browser-a", "Soundbar").await,
        offset("browser-a", "Soundbar", 0)
    );
}

#[tokio::test]
async fn each_browser_and_output_keeps_its_own_value_across_a_restart() {
    let mut app = TestApp::start().await;
    for body in [
        offset("stage", "Speakers", 120),
        offset("stage", "LG TV (HDMI)", -300),
        offset("stage", "JBL Flip (Bluetooth)", 500),
        offset("editor", "Speakers", 40),
    ] {
        let response = put(&app, &body).await;
        assert_eq!(response.status(), StatusCode::OK, "{body:?}");
        assert_eq!(response.json::<AvOffset>().await.unwrap(), body);
    }
    // A second write replaces the first.
    put(&app, &offset("stage", "Speakers", 130)).await;

    app.restart().await;

    assert_eq!(read(&app, "stage", "Speakers").await.av_offset_ms, 130);
    assert_eq!(read(&app, "stage", "LG TV (HDMI)").await.av_offset_ms, -300);
    assert_eq!(
        read(&app, "stage", "JBL Flip (Bluetooth)").await.av_offset_ms,
        500
    );
    assert_eq!(read(&app, "editor", "Speakers").await.av_offset_ms, 40);
    // A changed label is a new output, at 0; so is another browser's.
    assert_eq!(read(&app, "stage", "Speakers (2)").await.av_offset_ms, 0);
    assert_eq!(read(&app, "phone", "Speakers").await.av_offset_ms, 0);
}

#[tokio::test]
async fn a_value_outside_the_range_or_off_the_ten_ms_grid_is_refused() {
    let app = TestApp::start().await;
    put(&app, &offset("stage", "Speakers", 60)).await;
    for refused in [-310, 510, 125, 1, -5] {
        let response = put(&app, &offset("stage", "Speakers", refused)).await;
        assert_eq!(
            response.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{refused} ms"
        );
        assert_eq!(
            response.json::<UserMessage>().await.unwrap(),
            UserMessage::InvalidMessage
        );
    }
    assert_eq!(read(&app, "stage", "Speakers").await.av_offset_ms, 60);
}

/// The next message on `socket`, past change notices and Party changes.
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. } | ServerMessage::PartyChanged { .. } => {}
            message => return message,
        }
    }
}

async fn report(stage: &mut WsClient, browser: &str, output: &str) {
    stage
        .send(&ClientMessage::ReportStageOutput {
            stage_browser: browser.into(),
            stage_output: output.into(),
        })
        .await;
}

#[tokio::test]
async fn the_a_v_offset_and_the_openstar_volume_of_one_output_are_kept_apart() {
    let mut app = TestApp::start().await;
    // An A/V offset stored before any volume leaves the volume at 80.
    put(&app, &offset("stage-1", "Speakers", 200)).await;
    let mut stage = app.connect_stage().await;
    report(&mut stage, "stage-1", "Speakers").await;
    loop {
        if let ServerMessage::Volume { volume, stepped } = recv(&mut stage).await {
            assert_eq!((volume, stepped), (80, false));
            break;
        }
    }
    stage
        .send(&ClientMessage::StepVolume {
            step: VolumeStep::Up,
        })
        .await;
    assert_eq!(
        recv(&mut stage).await,
        ServerMessage::Volume {
            volume: 85,
            stepped: true
        }
    );
    // Stepping the volume keeps the offset, and a new offset keeps the volume.
    assert_eq!(read(&app, "stage-1", "Speakers").await.av_offset_ms, 200);
    put(&app, &offset("stage-1", "Speakers", -20)).await;

    drop(stage);
    app.restart().await;
    let mut stage = app.connect_stage().await;
    report(&mut stage, "stage-1", "Speakers").await;
    loop {
        if let ServerMessage::Volume { volume, .. } = recv(&mut stage).await {
            assert_eq!(volume, 85);
            break;
        }
    }
    assert_eq!(read(&app, "stage-1", "Speakers").await.av_offset_ms, -20);
}
