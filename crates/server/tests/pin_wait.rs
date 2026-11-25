//! The shared wrong-guess wait for the Admin PIN, over real HTTP on the real
//! axum app, with the server clock under the test's control (no real sleeping).

use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;

use openstar::clock::ManualClock;
use openstar::{Config, Server};
use openstar_protocol::UserMessage;
use openstar_protocol::admin::{ApiError, ApiErrorCode, UnlockRequest};
use reqwest::StatusCode;

const PIN: &str = "1234";
const WRONG: &str = "9999";

struct App {
    addr: SocketAddr,
    http: reqwest::Client,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    served: tokio::task::JoinHandle<std::io::Result<()>>,
}

/// Who sends an attempt: an optional cookie and an optional forwarded-for
/// address, so attempts can come from "different browsers".
#[derive(Default, Clone, Copy)]
struct From<'a> {
    cookie: Option<&'a str>,
    forwarded_for: Option<&'a str>,
}

/// What one attempt was answered with.
#[derive(Debug, PartialEq, Eq)]
enum Answer {
    Unlocked,
    WrongPin,
    Wait { seconds_left: u32 },
}

impl App {
    async fn start(appdata: &Path, songs: &Path, clock: &ManualClock) -> Self {
        let mut config = Config::for_tests(appdata, songs);
        config.admin_pin = openstar::Secret::new(PIN);
        let server = Server::start(&config)
            .await
            .expect("server starts")
            .with_clock(clock.clock());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let served = tokio::spawn(server.serve_with_shutdown(listener, async {
            let _ = rx.await;
        }));
        let app = Self {
            addr,
            http: reqwest::Client::new(),
            shutdown: Some(tx),
            served,
        };
        app.wait_for_the_start_up_scan().await;
        app
    }

    async fn wait_for_the_start_up_scan(&self) {
        let url = format!("http://{}/api/library/scan", self.addr);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let status: openstar_protocol::library::ScanStatus = self
                .http
                .get(&url)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if !status.running {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the start-up Library scan did not end"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn stop(mut self) {
        let _ = self.shutdown.take().unwrap().send(());
        self.served.await.unwrap().unwrap();
    }

    async fn attempt_from(&self, pin: &str, from: From<'_>) -> Answer {
        let mut request = self
            .http
            .post(format!("http://{}/api/unlock", self.addr))
            .json(&UnlockRequest {
                pin: pin.to_owned(),
            });
        if let Some(cookie) = from.cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(address) = from.forwarded_for {
            request = request.header("x-forwarded-for", address);
        }
        let response = request.send().await.unwrap();
        match response.status() {
            StatusCode::OK => Answer::Unlocked,
            StatusCode::FORBIDDEN => {
                let body: ApiError = response.json().await.unwrap();
                assert_eq!(body.code, ApiErrorCode::WrongPin);
                Answer::WrongPin
            }
            StatusCode::TOO_MANY_REQUESTS => {
                let retry_after: u32 = response
                    .headers()
                    .get("retry-after")
                    .expect("a wait answer has Retry-After")
                    .to_str()
                    .unwrap()
                    .parse()
                    .unwrap();
                match response.json::<UserMessage>().await.unwrap() {
                    UserMessage::AdminPinWait { seconds_left } => {
                        assert_eq!(retry_after, seconds_left);
                        Answer::Wait { seconds_left }
                    }
                    other => panic!("not a wait: {other:?}"),
                }
            }
            other => panic!("unexpected status {other}"),
        }
    }

    async fn attempt(&self, pin: &str) -> Answer {
        self.attempt_from(pin, From::default()).await
    }

    /// `n` wrong guesses that must each be checked (no wait running).
    async fn wrong_guesses(&self, n: usize) {
        for i in 0..n {
            assert_eq!(self.attempt(WRONG).await, Answer::WrongPin, "guess {i}");
        }
    }

    /// `n` wrong guesses in a row, sitting out each wait between them.
    async fn wrong_guesses_through_waits(&self, n: usize, clock: &ManualClock) {
        for i in 0..n {
            if let Answer::Wait { seconds_left } = self.attempt(WRONG).await {
                clock.advance(Duration::from_secs(seconds_left.into()));
                assert_eq!(self.attempt(WRONG).await, Answer::WrongPin, "guess {i}");
            }
        }
    }
}

struct Dirs {
    appdata: tempfile::TempDir,
    songs: tempfile::TempDir,
}

impl Dirs {
    fn new() -> Self {
        Self {
            appdata: tempfile::tempdir().unwrap(),
            songs: tempfile::tempdir().unwrap(),
        }
    }

    async fn start(&self, clock: &ManualClock) -> App {
        App::start(self.appdata.path(), self.songs.path(), clock).await
    }
}

fn minutes(n: u64) -> Duration {
    Duration::from_secs(n * 60)
}

#[tokio::test]
async fn five_wrong_guesses_cost_nothing_and_a_sixth_attempt_is_checked() {
    let d = Dirs::new();
    let clock = ManualClock::new();
    let app = d.start(&clock).await;

    app.wrong_guesses(5).await;
    assert_eq!(app.attempt(WRONG).await, Answer::WrongPin);

    let app2 = {
        app.stop().await;
        d.start(&clock).await
    };
    app2.wrong_guesses(5).await;
    assert_eq!(app2.attempt(PIN).await, Answer::Unlocked);
}

#[tokio::test]
async fn the_sixth_to_tenth_wrong_guesses_wait_1_2_4_8_15_minutes_then_15_for_ever() {
    let d = Dirs::new();
    let clock = ManualClock::new();
    let app = d.start(&clock).await;
    app.wrong_guesses(5).await;

    for wait in [1, 2, 4, 8, 15, 15, 15] {
        assert_eq!(app.attempt(WRONG).await, Answer::WrongPin);
        let seconds = u32::try_from(wait * 60).unwrap();
        assert_eq!(
            app.attempt(WRONG).await,
            Answer::Wait {
                seconds_left: seconds
            }
        );
        clock.advance(minutes(wait) - Duration::from_millis(1500));
        assert_eq!(app.attempt(WRONG).await, Answer::Wait { seconds_left: 2 });
        clock.advance(Duration::from_millis(1000));
        assert_eq!(app.attempt(PIN).await, Answer::Wait { seconds_left: 1 });
        clock.advance(Duration::from_millis(500));
    }
}

#[tokio::test]
async fn during_a_wait_even_the_correct_pin_is_refused_and_refusals_do_not_count() {
    let d = Dirs::new();
    let clock = ManualClock::new();
    let app = d.start(&clock).await;
    app.wrong_guesses(6).await;

    clock.advance(Duration::from_secs(20));
    assert_eq!(app.attempt(PIN).await, Answer::Wait { seconds_left: 40 });
    for _ in 0..10 {
        assert_eq!(app.attempt(WRONG).await, Answer::Wait { seconds_left: 40 });
    }

    // The 7th wrong guess starts a 2-minute wait, not a longer one.
    clock.advance(Duration::from_secs(40));
    assert_eq!(app.attempt(WRONG).await, Answer::WrongPin);
    assert_eq!(app.attempt(PIN).await, Answer::Wait { seconds_left: 120 });

    clock.advance(minutes(2));
    assert_eq!(app.attempt(PIN).await, Answer::Unlocked);
}

#[tokio::test]
async fn wrong_guesses_from_different_browsers_add_to_one_count() {
    let d = Dirs::new();
    let clock = ManualClock::new();
    let app = d.start(&clock).await;
    let browsers = [
        From::default(),
        From {
            cookie: Some("openstar_unlock=aaaa"),
            forwarded_for: Some("192.0.2.1"),
        },
        From {
            cookie: Some("other=1"),
            forwarded_for: Some("192.0.2.2"),
        },
        From {
            cookie: None,
            forwarded_for: Some("198.51.100.9, 10.0.0.1"),
        },
        From {
            cookie: Some("openstar_unlock=bbbb"),
            forwarded_for: None,
        },
        From {
            cookie: None,
            forwarded_for: Some("192.0.2.3"),
        },
    ];
    for browser in browsers {
        assert_eq!(app.attempt_from(WRONG, browser).await, Answer::WrongPin);
    }
    for browser in browsers {
        assert_eq!(
            app.attempt_from(PIN, browser).await,
            Answer::Wait { seconds_left: 60 }
        );
    }
}

#[tokio::test]
async fn a_correct_pin_after_the_wait_resets_the_count() {
    let d = Dirs::new();
    let clock = ManualClock::new();
    let app = d.start(&clock).await;
    app.wrong_guesses(6).await;
    clock.advance(minutes(1));
    assert_eq!(app.attempt(PIN).await, Answer::Unlocked);

    app.wrong_guesses(5).await;
    assert_eq!(app.attempt(PIN).await, Answer::Unlocked);
    app.wrong_guesses(6).await;
    assert_eq!(app.attempt(PIN).await, Answer::Wait { seconds_left: 60 });
}

#[tokio::test]
async fn a_restart_clears_the_count_and_any_running_wait() {
    let d = Dirs::new();
    let clock = ManualClock::new();
    let app = d.start(&clock).await;
    app.wrong_guesses_through_waits(9, &clock).await;
    assert_eq!(app.attempt(PIN).await, Answer::Wait { seconds_left: 480 });
    app.stop().await;

    let app = d.start(&clock).await;
    assert_eq!(app.attempt(PIN).await, Answer::Unlocked);
    app.wrong_guesses(6).await;
    assert_eq!(app.attempt(PIN).await, Answer::Wait { seconds_left: 60 });
}

/// Every row of every table, as text, so two snapshots can be compared.
fn database_contents(appdata: &Path) -> Vec<String> {
    let conn = rusqlite::Connection::open(appdata.join(openstar::db::DATABASE_FILE)).unwrap();
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let mut rows = Vec::new();
    for table in tables {
        let mut statement = conn.prepare(&format!("SELECT * FROM \"{table}\"")).unwrap();
        let columns = statement.column_count();
        let mut query = statement.query([]).unwrap();
        while let Some(row) = query.next().unwrap() {
            let values: Vec<String> = (0..columns)
                .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                .collect();
            rows.push(format!("{table}: {}", values.join(", ")));
        }
    }
    rows
}

#[tokio::test]
async fn nothing_about_the_count_or_the_wait_is_written_to_sqlite() {
    let d = Dirs::new();
    let clock = ManualClock::new();
    let app = d.start(&clock).await;
    let before = database_contents(d.appdata.path());

    app.wrong_guesses_through_waits(7, &clock).await;
    assert_eq!(app.attempt(PIN).await, Answer::Wait { seconds_left: 120 });
    assert_eq!(database_contents(d.appdata.path()), before);
    app.stop().await;
    assert_eq!(database_contents(d.appdata.path()), before);
}
