//! The log line of each wrong Admin PIN guess. A test binary of its own (a
//! `[[test]]` of its own in `Cargo.toml`, outside `tests/main.rs`):
//! the test installs a log subscriber, which tests running beside it on
//! other threads would disturb.

use std::io::Write;
use std::sync::{Arc, Mutex};

use openstar_protocol::admin::UnlockRequest;
use openstar_test_harness::TestApp;
use reqwest::StatusCode;

/// A log writer the test can read back.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Captured {
    fn lines(&self) -> Vec<String> {
        String::from_utf8(self.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

async fn wrong_guess(app: &TestApp, pin: &str, forwarded_for: Option<&str>) {
    let mut request = app
        .http()
        .post(app.url("/api/unlock"))
        .json(&UnlockRequest {
            pin: pin.to_owned(),
        });
    if let Some(address) = forwarded_for {
        request = request.header("x-forwarded-for", address);
    }
    let response = request.send().await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

// A current-thread runtime, so the server's handlers log through this
// thread's default subscriber.
#[tokio::test(flavor = "current_thread")]
async fn each_wrong_guess_logs_the_forwarded_and_peer_address_but_never_the_pin() {
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let app = TestApp::start().await;
    // Eight digits, so a timestamp in a log line cannot match by chance.
    let guesses = ["86420135", "86420136", "86420137", "86420138"];
    let forwarded = ["203.0.113.7", "203.0.113.8", "203.0.113.9"];
    for (pin, address) in guesses.iter().zip(forwarded) {
        wrong_guess(&app, pin, Some(address)).await;
    }
    // No forwarded-for header: the peer address is still logged.
    wrong_guess(&app, guesses[3], None).await;
    app.stop().await;

    let lines = captured.lines();
    let wrong: Vec<&String> = lines
        .iter()
        .filter(|line| line.contains("wrong Admin PIN"))
        .collect();
    assert_eq!(wrong.len(), 4, "{lines:#?}");
    for (line, address) in wrong.iter().zip(forwarded) {
        assert!(
            line.contains(&format!("forwarded_for=\"{address}\"")),
            "{line}"
        );
    }
    for line in &wrong {
        assert!(line.contains("peer=127.0.0.1:"), "{line}");
    }
    for line in &lines {
        for pin in guesses {
            assert!(!line.contains(pin), "a PIN attempt was logged: {line}");
        }
    }
}
