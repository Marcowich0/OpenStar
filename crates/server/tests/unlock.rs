//! The Admin PIN and the Unlock, over real HTTP on the real axum app, with the
//! server clock under the test's control (no real sleeping).

use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;

use openstar::clock::ManualClock;
use openstar::{Config, Server};
use openstar_protocol::admin::{ApiError, ApiErrorCode, UnlockRequest, UnlockStatus};
use reqwest::StatusCode;

const PIN: &str = "1234";

struct App {
    addr: SocketAddr,
    http: reqwest::Client,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    served: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl App {
    async fn start(appdata: &Path, songs: &Path, pin: &str, clock: &ManualClock) -> Self {
        let mut config = Config::for_tests(appdata, songs);
        config.admin_pin = openstar::Secret::new(pin);
        let server = Server::start(&config)
            .await
            .expect("server starts")
            .with_clock(clock.clock())
            .with_test_routes();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let served = tokio::spawn(server.serve_with_shutdown(listener, async {
            let _ = rx.await;
        }));
        Self {
            addr,
            http: reqwest::Client::new(),
            shutdown: Some(tx),
            served,
        }
    }

    async fn stop(mut self) {
        let _ = self.shutdown.take().unwrap().send(());
        self.served.await.unwrap().unwrap();
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        cookie: Option<&str>,
    ) -> reqwest::Response {
        let mut request = self.http.request(method, self.url(path));
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        request.send().await.unwrap()
    }

    async fn attempt(&self, pin: &str) -> reqwest::Response {
        self.http
            .post(self.url("/api/unlock"))
            .json(&UnlockRequest {
                pin: pin.to_owned(),
            })
            .send()
            .await
            .unwrap()
    }

    /// Unlocks with the right PIN and returns the `name=value` pair to send back.
    async fn unlock(&self) -> String {
        let response = self.attempt(PIN).await;
        assert_eq!(response.status(), StatusCode::OK);
        cookie_pair(&response).expect("the Unlock sets a cookie")
    }

    async fn status(&self, cookie: Option<&str>) -> bool {
        let response = self.send(reqwest::Method::GET, "/api/unlock", cookie).await;
        assert_eq!(response.status(), StatusCode::OK);
        response.json::<UnlockStatus>().await.unwrap().unlocked
    }

    async fn guarded(&self, cookie: Option<&str>) -> reqwest::Response {
        self.send(reqwest::Method::POST, "/api/test/guarded", cookie)
            .await
    }

    async fn heartbeat(&self, cookie: Option<&str>) -> reqwest::Response {
        self.send(reqwest::Method::POST, "/api/unlock/heartbeat", cookie)
            .await
    }

    async fn lock(&self, cookie: Option<&str>) -> reqwest::Response {
        self.send(reqwest::Method::POST, "/api/lock", cookie).await
    }
}

fn set_cookie(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get("set-cookie")
        .map(|value| value.to_str().unwrap().to_owned())
}

fn cookie_pair(response: &reqwest::Response) -> Option<String> {
    set_cookie(response).map(|value| value.split(';').next().unwrap().trim().to_owned())
}

async fn assert_refused(response: reqwest::Response, code: ApiErrorCode) {
    let status = response.status();
    let body: ApiError = response.json().await.unwrap();
    assert_eq!(body.code, code, "status {status}");
}

struct Dirs {
    appdata: tempfile::TempDir,
    songs: tempfile::TempDir,
}

fn dirs() -> Dirs {
    Dirs {
        appdata: tempfile::tempdir().unwrap(),
        songs: tempfile::tempdir().unwrap(),
    }
}

async fn start(d: &Dirs, clock: &ManualClock) -> App {
    App::start(d.appdata.path(), d.songs.path(), PIN, clock).await
}

#[tokio::test]
async fn a_correct_pin_sets_an_http_only_same_site_strict_cookie_and_unlocks() {
    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;
    assert!(!app.status(None).await);

    let response = app.attempt(PIN).await;
    assert_eq!(response.status(), StatusCode::OK);
    let header = set_cookie(&response).expect("a cookie is set");
    let attributes: Vec<String> = header
        .split(';')
        .skip(1)
        .map(|a| a.trim().to_ascii_lowercase())
        .collect();
    assert!(attributes.contains(&"httponly".to_owned()), "{header}");
    assert!(
        attributes.contains(&"samesite=strict".to_owned()),
        "{header}"
    );
    assert!(attributes.contains(&"path=/".to_owned()), "{header}");
    let body: UnlockStatus = response.json().await.unwrap();
    assert!(body.unlocked);

    let cookie = header.split(';').next().unwrap().to_owned();
    assert!(app.status(Some(&cookie)).await);
}

#[tokio::test]
async fn a_wrong_pin_sets_no_cookie_and_answers_with_a_code() {
    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;

    for wrong in ["4321", "12345", "", "abcd"] {
        let response = app.attempt(wrong).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(set_cookie(&response), None);
        assert_refused(response, ApiErrorCode::WrongPin).await;
    }
    assert!(!app.status(None).await);
}

#[tokio::test]
async fn a_guarded_endpoint_needs_an_unlock() {
    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;

    let response = app.guarded(None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_refused(response, ApiErrorCode::UnlockRequired).await;

    let cookie = app.unlock().await;
    assert_eq!(
        app.guarded(Some(&cookie)).await.status(),
        StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn a_guarded_endpoint_refuses_an_unknown_cookie() {
    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;
    let _real = app.unlock().await;

    for forged in [
        format!("openstar_unlock={}", "0".repeat(64)),
        "openstar_unlock=not-a-token".to_owned(),
        "openstar_unlock=".to_owned(),
        "other=1".to_owned(),
    ] {
        let response = app.guarded(Some(&forged)).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{forged}");
        assert_refused(response, ApiErrorCode::UnlockRequired).await;
        assert!(!app.status(Some(&forged)).await, "{forged}");
    }
}

#[tokio::test]
async fn an_unlock_expires_after_30_idle_minutes_of_server_clock() {
    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;
    let cookie = app.unlock().await;

    clock.advance(Duration::from_secs(30 * 60) - Duration::from_millis(1));
    assert!(
        app.status(Some(&cookie)).await,
        "still live just before 30 minutes"
    );
    clock.advance(Duration::from_millis(1));
    assert!(!app.status(Some(&cookie)).await, "ended at 30 minutes");
    let response = app.guarded(Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_refused(response, ApiErrorCode::UnlockRequired).await;
}

#[tokio::test]
async fn a_guarded_action_resets_the_idle_time() {
    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;
    let cookie = app.unlock().await;

    clock.advance(Duration::from_secs(20 * 60));
    assert_eq!(
        app.guarded(Some(&cookie)).await.status(),
        StatusCode::NO_CONTENT
    );
    clock.advance(Duration::from_secs(20 * 60));
    assert!(
        app.status(Some(&cookie)).await,
        "40 minutes after the PIN, 20 after the action"
    );
    clock.advance(Duration::from_secs(10 * 60));
    assert!(
        !app.status(Some(&cookie)).await,
        "30 minutes after the action"
    );
}

#[tokio::test]
async fn a_heartbeat_resets_the_idle_time() {
    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;
    let cookie = app.unlock().await;

    clock.advance(Duration::from_secs(20 * 60));
    let response = app.heartbeat(Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.json::<UnlockStatus>().await.unwrap().unlocked);
    clock.advance(Duration::from_secs(20 * 60));
    assert_eq!(
        app.guarded(Some(&cookie)).await.status(),
        StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn the_status_request_does_not_reset_the_idle_time() {
    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;
    let cookie = app.unlock().await;

    clock.advance(Duration::from_secs(20 * 60));
    assert!(app.status(Some(&cookie)).await);
    clock.advance(Duration::from_secs(10 * 60));
    assert_eq!(
        app.guarded(Some(&cookie)).await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn a_heartbeat_never_creates_or_revives_an_unlock() {
    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;

    let response = app.heartbeat(None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(set_cookie(&response), None);
    assert_refused(response, ApiErrorCode::UnlockRequired).await;

    let cookie = app.unlock().await;
    clock.advance(Duration::from_secs(30 * 60));
    let response = app.heartbeat(Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_refused(response, ApiErrorCode::UnlockRequired).await;
    assert!(!app.status(Some(&cookie)).await);
    assert_eq!(
        app.guarded(Some(&cookie)).await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn lock_ends_the_unlock_at_once() {
    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;
    let cookie = app.unlock().await;
    let other_browser = app.unlock().await;

    let response = app.lock(Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let cleared = set_cookie(&response).expect("Lock clears the cookie");
    assert!(
        cleared.to_ascii_lowercase().contains("max-age=0"),
        "{cleared}"
    );
    assert!(!response.json::<UnlockStatus>().await.unwrap().unlocked);

    assert!(!app.status(Some(&cookie)).await);
    let response = app.guarded(Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_refused(response, ApiErrorCode::UnlockRequired).await;
    assert!(
        app.status(Some(&other_browser)).await,
        "Lock ends only this browser's Unlock"
    );
}

#[tokio::test]
async fn lock_needs_no_unlock() {
    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;

    assert_eq!(app.lock(None).await.status(), StatusCode::OK);
    let stale = format!("openstar_unlock={}", "f".repeat(64));
    assert_eq!(app.lock(Some(&stale)).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_restart_with_the_same_pin_keeps_the_unlock() {
    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;
    let cookie = app.unlock().await;
    clock.advance(Duration::from_secs(10 * 60));
    app.stop().await;

    let app = start(&d, &clock).await;
    assert!(app.status(Some(&cookie)).await);
    assert_eq!(
        app.guarded(Some(&cookie)).await.status(),
        StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn a_restart_with_a_different_pin_ends_the_unlock() {
    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;
    let cookie = app.unlock().await;
    app.stop().await;

    let app = App::start(d.appdata.path(), d.songs.path(), "98765", &clock).await;
    assert!(!app.status(Some(&cookie)).await);
    let response = app.guarded(Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_refused(response, ApiErrorCode::UnlockRequired).await;
    app.stop().await;

    // Going back to the old PIN does not revive it either.
    let app = start(&d, &clock).await;
    assert!(!app.status(Some(&cookie)).await);
}

/// Every value in every table of the database, as text or bytes.
fn stored_values(db: &Path) -> Vec<rusqlite::types::Value> {
    let conn = rusqlite::Connection::open(db).unwrap();
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let mut values = Vec::new();
    for table in tables {
        let mut statement = conn.prepare(&format!("SELECT * FROM \"{table}\"")).unwrap();
        let columns = statement.column_count();
        let mut rows = statement.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            for column in 0..columns {
                values.push(row.get(column).unwrap());
            }
        }
    }
    values
}

#[tokio::test]
async fn sqlite_never_holds_the_pin_itself() {
    use rusqlite::types::Value;

    let d = dirs();
    let clock = ManualClock::new();
    let pin = "73914862";
    let app = App::start(d.appdata.path(), d.songs.path(), pin, &clock).await;
    let response = app.attempt(pin).await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = cookie_pair(&response).unwrap();
    assert_eq!(app.attempt("1111").await.status(), StatusCode::FORBIDDEN);
    assert_eq!(app.heartbeat(Some(&cookie)).await.status(), StatusCode::OK);
    app.stop().await;

    let values = stored_values(&d.appdata.path().join("openstar.db"));
    assert!(
        values.iter().any(|v| matches!(v, Value::Blob(_))),
        "the Unlock was stored"
    );
    for value in values {
        let holds_pin = match &value {
            Value::Integer(i) => i.to_string() == pin,
            Value::Real(r) => r.to_string().contains(pin),
            Value::Text(t) => t.contains(pin),
            Value::Blob(b) => b.windows(pin.len()).any(|w| w == pin.as_bytes()),
            Value::Null => false,
        };
        assert!(!holds_pin, "the PIN is stored as {value:?}");
    }
}

#[tokio::test]
async fn no_websocket_message_unlocks_locks_or_performs_a_guarded_action() {
    use futures_util::{SinkExt, StreamExt};
    use openstar_protocol::{RejectCode, ServerMessage};
    use tokio_tungstenite::tungstenite::Message;

    let d = dirs();
    let clock = ManualClock::new();
    let app = start(&d, &clock).await;
    let cookie = app.unlock().await;

    let mut request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(format!(
            "ws://{}/ws",
            app.addr
        ))
        .unwrap();
    request
        .headers_mut()
        .insert("cookie", cookie.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();

    for attempt in [
        format!(r#"{{"type":"unlock","pin":"{PIN}"}}"#),
        r#"{"type":"lock"}"#.to_owned(),
        r#"{"type":"heartbeat"}"#.to_owned(),
        r#"{"type":"guarded"}"#.to_owned(),
    ] {
        socket.send(Message::text(attempt.clone())).await.unwrap();
        let answer = socket.next().await.unwrap().unwrap();
        let answer: ServerMessage = serde_json::from_str(answer.to_text().unwrap()).unwrap();
        assert_eq!(
            answer,
            ServerMessage::Rejected {
                code: RejectCode::InvalidMessage
            },
            "{attempt}"
        );
    }
    assert!(
        app.status(Some(&cookie)).await,
        "a WebSocket lock did nothing"
    );
    assert!(!app.status(None).await, "a WebSocket unlock did nothing");
}
