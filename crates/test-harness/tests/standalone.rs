//! The fake USDB and the yt-dlp stub as standalone processes, for `just e2e`.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

use openstar_test_harness::RecordedRequest;

const HARNESS: &str = env!("CARGO_BIN_EXE_openstar-harness");

/// Kills the process when the test ends, also on a panic.
struct Killed(Child);

impl Drop for Killed {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn the_fake_usdb_runs_as_a_process_that_can_be_read_and_scripted_over_http() {
    let mut child = Command::new(HARNESS)
        .args(["fake-usdb", "--port", "0"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut first_line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut first_line)
        .unwrap();
    let _process = Killed(child);
    let base = first_line.trim().to_owned();
    assert!(base.starts_with("http://127.0.0.1:"), "{base}");
    let http = reqwest::Client::new();

    let scripted = http
        .post(format!("{base}/__fake/script"))
        .body(r#"{"times":1,"response":{"kind":"error","status":429,"retryAfter":7}}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(scripted.status(), 204);

    let limited = http
        .get(format!("{base}/index.php?link=list"))
        .send()
        .await
        .unwrap();
    assert_eq!(limited.status(), 429);
    assert_eq!(limited.headers()["retry-after"], "7");
    let page = http
        .get(format!("{base}/index.php?link=list"))
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), 200);

    let requests: Vec<RecordedRequest> = http
        .get(format!("{base}/__fake/requests"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(requests.len(), 2, "control requests are not recorded");
    assert_eq!(requests[1].query, "link=list");
}

#[test]
fn the_ytdlp_stub_installs_into_a_folder_for_the_front_of_path() {
    let dir = tempfile::tempdir().unwrap();
    let status = Command::new(HARNESS)
        .arg("ytdlp-stub")
        .arg(dir.path())
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());

    let path = std::env::join_paths(
        std::iter::once(dir.path().to_path_buf())
            .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    let version = Command::new("yt-dlp")
        .env("PATH", path)
        .arg("--version")
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&version.stdout).contains("openstar-stub"));
    assert!(dir.path().join("calls/000001.args").is_file());
}
