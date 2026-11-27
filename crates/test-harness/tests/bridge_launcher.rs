//! The Mic bridge launcher: starts and stops Mic bridge processes on this
//! machine for a Playwright spec, over HTTP. A shell script stands in for the
//! bridge here; `just e2e` gives it the real `openstar-mic-bridge`.

use std::io::{BufRead, BufReader};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use openstar_test_harness::{BridgeLauncher, LaunchSettings, write_executable};

const HARNESS: &str = env!("CARGO_BIN_EXE_openstar-harness");

/// Writes the fake bridge's own pid and what it was given into its output,
/// then sleeps until killed (`exec`, so the pid is the sleep's).
const FAKE_BRIDGE: &str = r#"#!/bin/sh
echo "pid $$"
echo "args $*"
echo "server $(cat "$XDG_CONFIG_HOME/openstar-mic-bridge/server")"
echo "home $HOME"
echo "wav $(basename "$2") $(wc -c < "$2")"
echo "on stderr" >&2
exec sleep 600
"#;

struct Setup {
    _dir: tempfile::TempDir,
    settings: LaunchSettings,
}

fn setup() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let bridge = dir.path().join("fake-bridge");
    write_executable(&bridge, FAKE_BRIDGE).unwrap();
    let wav = dir.path().join("multichannel.wav");
    std::fs::write(&wav, b"RIFF0123").unwrap();
    Setup {
        settings: LaunchSettings {
            bridge,
            server: "http://127.0.0.1:9".into(),
            wav,
        },
        _dir: dir,
    }
}

async fn launcher(settings: LaunchSettings) -> BridgeLauncher {
    BridgeLauncher::serve(settings, SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .unwrap()
}

async fn start(http: &reqwest::Client, base: &str, body: &str) -> u64 {
    let response = http
        .post(format!("{base}/bridges"))
        .header("content-type", "application/json")
        .body(body.to_owned())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201);
    let started: serde_json::Value = response.json().await.unwrap();
    started["id"].as_u64().unwrap()
}

async fn output(http: &reqwest::Client, base: &str, id: u64) -> reqwest::Response {
    http.get(format!("{base}/bridges/{id}/output"))
        .send()
        .await
        .unwrap()
}

/// The bridge's output once it holds `line`.
async fn output_with(http: &reqwest::Client, base: &str, id: u64, line: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let text = output(http, base, id).await.text().await.unwrap();
        if text.lines().any(|l| l.starts_with(line)) {
            return text;
        }
        assert!(Instant::now() < deadline, "no {line:?} in {text:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn pid_in(output: &str) -> u32 {
    output
        .lines()
        .find_map(|l| l.strip_prefix("pid "))
        .unwrap()
        .parse()
        .unwrap()
}

fn running(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

async fn gone(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while running(pid) {
        assert!(Instant::now() < deadline, "process {pid} still runs");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_started_bridge_runs_on_the_wav_with_its_own_config_and_its_output_is_readable() {
    let setup = setup();
    let launcher = launcher(setup.settings.clone()).await;
    let http = reqwest::Client::new();
    let base = launcher.base_url();

    let id = start(&http, &base, r#"{"wavName":"flow-5.wav"}"#).await;
    let text = output_with(&http, &base, id, "on stderr").await;
    assert!(text.contains("server http://127.0.0.1:9\n"), "{text}");
    assert!(text.contains("args --wav "), "{text}");
    // The same WAV under the asked name: the bridge names its interface by it.
    assert!(text.contains("wav flow-5.wav 8\n"), "{text}");
    assert!(running(pid_in(&text)));

    // A second bridge is a new one: its own config, so its own approval.
    let other = start(&http, &base, "{}").await;
    assert_ne!(other, id);
    let second = output_with(&http, &base, other, "on stderr").await;
    assert!(second.contains("wav multichannel.wav 8\n"), "{second}");
    let home = |t: &str| {
        t.lines()
            .find(|l| l.starts_with("home "))
            .unwrap()
            .to_owned()
    };
    assert_ne!(home(&text), home(&second));
}

#[tokio::test]
async fn stopping_a_bridge_ends_its_process_and_answers_its_output() {
    let setup = setup();
    let launcher = launcher(setup.settings.clone()).await;
    let http = reqwest::Client::new();
    let base = launcher.base_url();
    let id = start(&http, &base, "{}").await;
    let pid = pid_in(&output_with(&http, &base, id, "on stderr").await);

    let stopped = http
        .delete(format!("{base}/bridges/{id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(stopped.status(), 200);
    assert!(stopped.text().await.unwrap().contains("on stderr"));
    // Killed and reaped before the answer.
    assert!(!running(pid));

    let again = http
        .delete(format!("{base}/bridges/{id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 404);
    assert_eq!(output(&http, &base, 99).await.status(), 404);
}

#[tokio::test]
async fn a_wav_name_with_a_folder_in_it_is_refused() {
    let setup = setup();
    let launcher = launcher(setup.settings.clone()).await;
    let response = reqwest::Client::new()
        .post(format!("{}/bridges", launcher.base_url()))
        .header("content-type", "application/json")
        .body(r#"{"wavName":"../x.wav"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn dropping_the_launcher_stops_every_bridge_it_started() {
    let setup = setup();
    let launcher = launcher(setup.settings.clone()).await;
    let http = reqwest::Client::new();
    let base = launcher.base_url();
    let id = start(&http, &base, "{}").await;
    let pid = pid_in(&output_with(&http, &base, id, "on stderr").await);

    drop(launcher);
    gone(pid).await;
}

/// Kills the process when the test ends, also on a panic.
struct Killed(Child);

impl Drop for Killed {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn arg(path: &Path) -> &str {
    path.to_str().unwrap()
}

#[tokio::test]
async fn the_standalone_launcher_stops_its_bridges_when_it_is_terminated() {
    let setup = setup();
    let LaunchSettings {
        bridge,
        server,
        wav,
    } = setup.settings.clone();
    let mut child = Command::new(HARNESS)
        .args(["bridge-launcher", "--bridge", arg(&bridge)])
        .args(["--server", &server, "--wav", arg(&wav)])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut first_line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut first_line)
        .unwrap();
    let mut process = Killed(child);
    let base = first_line.trim().to_owned();
    assert!(base.starts_with("http://127.0.0.1:"), "{base}");
    let http = reqwest::Client::new();
    let id = start(&http, &base, "{}").await;
    let pid = pid_in(&output_with(&http, &base, id, "on stderr").await);

    let launcher_pid = process.0.id().to_string();
    let killed = Command::new("kill")
        .args(["-TERM", &launcher_pid])
        .status()
        .unwrap();
    assert!(killed.success());
    let status = process.0.wait().unwrap();
    assert!(status.success(), "{status}");
    gone(pid).await;
}
