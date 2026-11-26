//! Stage trust over real HTTP: a browser gives the Admin PIN once
//! (`POST /api/stage/trust`) and is remembered by its Stage cookie, which the
//! Stage's WebSocket upgrade (`GET /ws/stage`) requires. Stage trust is not an
//! Unlock, and an Unlock is not Stage trust.

use openstar_protocol::admin::{ApiError, ApiErrorCode, StageTrustRequest, StageTrustStatus};
use openstar_protocol::{ServerMessage, UserMessage};
use openstar_test_harness::{AppFolders, DEFAULT_ADMIN_PIN, TestApp};
use reqwest::StatusCode;
use reqwest::header::{COOKIE, SET_COOKIE};

const STAGE_COOKIE: &str = "openstar_stage";

/// One `POST /api/stage/trust`, sent with `cookie` (a `Cookie` header value) if any.
async fn ask_for_trust(
    app: &TestApp,
    pin: Option<&str>,
    cookie: Option<&str>,
) -> reqwest::Response {
    let mut request = app
        .http()
        .post(app.url("/api/stage/trust"))
        .json(&StageTrustRequest {
            pin: pin.map(str::to_owned),
        });
    if let Some(cookie) = cookie {
        request = request.header(COOKIE, cookie);
    }
    request.send().await.unwrap()
}

/// The `name=value` part of the Set-Cookie header named `name`.
fn set_cookie(response: &reqwest::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find(|v| v.starts_with(&format!("{name}=")))
        .map(|v| v.split(';').next().unwrap().to_owned())
}

async fn api_error(response: reqwest::Response) -> ApiErrorCode {
    response.json::<ApiError>().await.unwrap().code
}

/// A correct PIN: the browser is now trusted. Returns its Cookie header value.
async fn trusted_with_pin(app: &TestApp, pin: &str) -> String {
    let response = ask_for_trust(app, Some(pin), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = set_cookie(&response, STAGE_COOKIE).expect("a Stage cookie is set");
    assert_eq!(
        response.json::<StageTrustStatus>().await.unwrap(),
        StageTrustStatus { trusted: true }
    );
    cookie
}

async fn assert_is_the_stage(app: &TestApp, cookie: &str) {
    let mut stage = app
        .try_connect_ws_at("/ws/stage", Some(cookie))
        .await
        .expect("a trusted browser opens the Stage's WebSocket");
    match stage.recv().await {
        ServerMessage::LiveState { is_stage, .. } => assert!(is_stage),
        other => panic!("expected the live state, got {other:?}"),
    }
}

#[tokio::test]
async fn a_browser_that_is_not_remembered_cannot_become_the_stage_without_the_pin() {
    let app = TestApp::start().await;

    let refused = app.try_connect_ws_at("/ws/stage", None).await.unwrap_err();
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    assert_eq!(
        serde_json::from_str::<ApiError>(&refused.body)
            .unwrap()
            .code,
        ApiErrorCode::StagePinRequired
    );

    let asked = ask_for_trust(&app, None, None).await;
    assert_eq!(asked.status(), StatusCode::FORBIDDEN);
    assert_eq!(api_error(asked).await, ApiErrorCode::StagePinRequired);

    let made_up = format!("{STAGE_COOKIE}={}", "ab".repeat(32));
    let refused = app
        .try_connect_ws_at("/ws/stage", Some(&made_up))
        .await
        .unwrap_err();
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    // Plain browsers still open `/ws` with no PIN.
    app.connect_ws().await;
}

#[tokio::test]
async fn with_a_correct_pin_the_browser_becomes_the_stage_and_is_remembered() {
    let app = TestApp::start().await;
    let cookie = trusted_with_pin(&app, DEFAULT_ADMIN_PIN).await;
    assert_is_the_stage(&app, &cookie).await;

    // Its next visit (or a reload) needs no PIN: the check answers from the cookie.
    let again = ask_for_trust(&app, None, Some(&cookie)).await;
    assert_eq!(again.status(), StatusCode::OK);
    assert_eq!(
        again.json::<StageTrustStatus>().await.unwrap(),
        StageTrustStatus { trusted: true }
    );
    assert_is_the_stage(&app, &cookie).await;
}

#[tokio::test]
async fn a_wrong_pin_is_refused_and_remembers_nothing() {
    let app = TestApp::start().await;
    let wrong = ask_for_trust(&app, Some("0000"), None).await;
    assert_eq!(wrong.status(), StatusCode::FORBIDDEN);
    assert_eq!(set_cookie(&wrong, STAGE_COOKIE), None);
    assert_eq!(api_error(wrong).await, ApiErrorCode::WrongPin);
}

#[tokio::test]
async fn a_remembered_stage_browser_holds_no_unlock() {
    let app = TestApp::builder().test_routes().start().await;
    let cookie = trusted_with_pin(&app, DEFAULT_ADMIN_PIN).await;
    let guarded = app
        .http()
        .post(app.url("/api/test/guarded"))
        .header(COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(guarded.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(api_error(guarded).await, ApiErrorCode::UnlockRequired);
}

#[tokio::test]
async fn a_browser_that_holds_an_unlock_still_needs_the_pin_to_become_the_stage() {
    let app = TestApp::start().await;
    let unlocked = app
        .http()
        .post(app.url("/api/unlock"))
        .json(&openstar_protocol::admin::UnlockRequest {
            pin: DEFAULT_ADMIN_PIN.to_owned(),
        })
        .send()
        .await
        .unwrap();
    assert_eq!(unlocked.status(), StatusCode::OK);
    let unlock_cookie = set_cookie(&unlocked, "openstar_unlock").expect("an Unlock cookie");

    let refused = app
        .try_connect_ws_at("/ws/stage", Some(&unlock_cookie))
        .await
        .unwrap_err();
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    let asked = ask_for_trust(&app, None, Some(&unlock_cookie)).await;
    assert_eq!(api_error(asked).await, ApiErrorCode::StagePinRequired);
}

#[tokio::test]
async fn wrong_pins_for_the_stage_share_the_admin_pin_wait() {
    let app = TestApp::start().await;
    // Three wrong at the Admin PIN pad and three at the Stage: the sixth in a
    // row starts the shared wait.
    for _ in 0..3 {
        let response = app
            .http()
            .post(app.url("/api/unlock"))
            .json(&openstar_protocol::admin::UnlockRequest {
                pin: "0000".to_owned(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    for _ in 0..3 {
        let response = ask_for_trust(&app, Some("0000"), None).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    // Now even the correct PIN waits, at the Stage and at the Unlock.
    let waiting = ask_for_trust(&app, Some(DEFAULT_ADMIN_PIN), None).await;
    assert_eq!(waiting.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(matches!(
        waiting.json::<UserMessage>().await.unwrap(),
        UserMessage::AdminPinWait { .. }
    ));
    let unlock = app
        .http()
        .post(app.url("/api/unlock"))
        .json(&openstar_protocol::admin::UnlockRequest {
            pin: DEFAULT_ADMIN_PIN.to_owned(),
        })
        .send()
        .await
        .unwrap();
    assert_eq!(unlock.status(), StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_plain_restart_keeps_remembered_stage_browsers() {
    let mut app = TestApp::start().await;
    let cookie = trusted_with_pin(&app, DEFAULT_ADMIN_PIN).await;
    app.restart().await;
    assert_is_the_stage(&app, &cookie).await;
}

#[tokio::test]
async fn a_restart_with_a_different_pin_forgets_every_stage_browser() {
    let app = TestApp::start().await;
    let cookie = trusted_with_pin(&app, DEFAULT_ADMIN_PIN).await;
    let folders: AppFolders = app.stop().await;

    let app = TestApp::builder()
        .folders(folders)
        .admin_pin("98765")
        .start()
        .await;
    let refused = app
        .try_connect_ws_at("/ws/stage", Some(&cookie))
        .await
        .unwrap_err();
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    let asked = ask_for_trust(&app, None, Some(&cookie)).await;
    assert_eq!(api_error(asked).await, ApiErrorCode::StagePinRequired);

    // The new PIN trusts it again.
    let cookie = trusted_with_pin(&app, "98765").await;
    assert_is_the_stage(&app, &cookie).await;
}

#[tokio::test]
async fn the_harness_stage_is_a_trusted_browser() {
    let app = TestApp::start().await;
    let mut stage = app.connect_stage().await;
    match stage.recv().await {
        ServerMessage::LiveState { is_stage, .. } => assert!(is_stage),
        other => panic!("expected the live state, got {other:?}"),
    }
}
