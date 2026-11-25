//! The real `openstar-mic-bridge` binary, headless with `--wav`, against the
//! real app in-process: it reads its server address from its config folder
//! (under `XDG_CONFIG_HOME`), waits for approval with the code the Stage
//! shows, keeps its token there and connects straight in on later starts.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use openstar_protocol::bridge::{MicBridges, bridge_local_mic_id};
use openstar_protocol::{ChangeTopic, ClientMessage, ServerMessage};
use openstar_test_harness::{TestApp, WsClient, fake_mic};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, BufReader, Lines};
use tokio::process::{Child, ChildStdout, Command};

const BRIDGE: &str = env!("CARGO_BIN_EXE_openstar-mic-bridge");
const WAIT: Duration = Duration::from_secs(10);

/// A temporary `XDG_CONFIG_HOME` and the bridge's folder inside it.
struct ConfigHome {
    home: tempfile::TempDir,
}

impl ConfigHome {
    fn new() -> Self {
        Self {
            home: tempfile::tempdir().unwrap(),
        }
    }

    fn bridge_dir(&self) -> PathBuf {
        self.home.path().join("openstar-mic-bridge")
    }

    fn write_server(&self, address: &str) {
        std::fs::create_dir_all(self.bridge_dir()).unwrap();
        std::fs::write(self.bridge_dir().join("server"), format!("{address}\n")).unwrap();
    }
}

/// A running bridge and its stdout, line by line.
struct Bridge {
    child: Child,
    lines: Lines<BufReader<ChildStdout>>,
}

impl Bridge {
    fn start(config: &ConfigHome, wav: &Path) -> Self {
        let mut child = Command::new(BRIDGE)
            .arg("--wav")
            .arg(wav)
            .env_clear()
            .env("XDG_CONFIG_HOME", config.home.path())
            .env("HOME", "/nonexistent")
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        Self { child, lines }
    }

    /// Waits for a line that starts with `prefix` and returns the rest.
    async fn line(&mut self, prefix: &str) -> String {
        tokio::time::timeout(WAIT, async {
            loop {
                let line = self
                    .lines
                    .next_line()
                    .await
                    .unwrap()
                    .unwrap_or_else(|| panic!("the bridge ended before printing {prefix:?}"));
                if let Some(rest) = line.strip_prefix(prefix) {
                    return rest.to_owned();
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("the bridge printed no {prefix:?} line within 10 s"))
    }

    /// Waits for the line `prefix` + `rest`, past other lines with the
    /// same prefix.
    async fn until(&mut self, prefix: &str, rest: &str) {
        while self.line(prefix).await != rest {}
    }

    async fn stop(mut self) {
        self.child.kill().await.unwrap();
    }
}

async fn open_stage(app: &TestApp) -> WsClient {
    let mut stage = app.connect_stage().await;
    assert!(matches!(
        stage.recv().await,
        ServerMessage::LiveState { is_stage: true, .. }
    ));
    assert!(matches!(
        stage.recv().await,
        ServerMessage::PartyChanged { .. }
    ));
    stage
}

async fn bridges_changed(stage: &mut WsClient) {
    assert_eq!(
        stage.recv().await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::MicBridges]
        }
    );
}

fn host_name() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .unwrap()
        .trim()
        .to_owned()
}

#[tokio::test]
async fn version_prints_the_same_build_identifier_as_the_server() {
    let output = Command::new(BRIDGE)
        .arg("--version")
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        openstar::BUILD_ID
    );
}

#[tokio::test]
async fn without_a_server_address_it_says_where_to_write_one() {
    let config = ConfigHome::new();
    let output = Command::new(BRIDGE)
        .args(["--wav", "anything.wav"])
        .env_clear()
        .env("XDG_CONFIG_HOME", config.home.path())
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(
        error.contains(&config.bridge_dir().join("server").display().to_string()),
        "{error}"
    );
}

#[tokio::test]
async fn a_wav_bridge_is_approved_on_the_stage_keeps_its_token_and_then_connects_straight_in() {
    let app = TestApp::start().await;
    let mic = tempfile::tempdir().unwrap();
    let wav = fake_mic::write(mic.path()).unwrap().multichannel;
    let config = ConfigHome::new();
    config.write_server(&app.base_url());
    let mut stage = open_stage(&app).await;

    // First start: it waits for approval with the code the Stage lists.
    let mut bridge = Bridge::start(&config, &wav);
    let code = bridge
        .line("Waiting for approval on the Stage: code ")
        .await;
    bridges_changed(&mut stage).await;
    let listed: MicBridges = app.get_json("/api/mic-bridges").await;
    let [request] = listed.requests.as_slice() else {
        panic!("one bridge waits: {listed:?}");
    };
    assert_eq!(
        (request.host_name.clone(), request.code.clone()),
        (host_name(), code)
    );
    stage
        .send(&ClientMessage::ApproveBridge {
            request_id: request.request_id,
        })
        .await;
    bridge.line("Connected").await;
    bridges_changed(&mut stage).await;

    // Its token is in its config folder, readable by its owner alone, and
    // is its identity.
    let token_file = config.bridge_dir().join("token");
    let token = std::fs::read_to_string(&token_file).unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&token_file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let listed: MicBridges = app.get_json("/api/mic-bridges").await;
    let approved = &listed.bridges[0];
    let hash: String = Sha256::digest(token.trim().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(approved.bridge_id.0, hash);

    // One hardware channel per WAV channel; the file name is the device.
    assert_eq!(
        approved
            .channels
            .iter()
            .map(|c| c.local_mic_id.clone())
            .collect::<Vec<_>>(),
        (0..4)
            .map(|n| bridge_local_mic_id(&approved.bridge_id, "multichannel.wav", n))
            .collect::<Vec<_>>()
    );
    bridge.stop().await;
    bridges_changed(&mut stage).await;

    // Later start: straight in, no approval.
    let mut bridge = Bridge::start(&config, &wav);
    bridge.line("Connected").await;
    bridges_changed(&mut stage).await;
    let listed: MicBridges = app.get_json("/api/mic-bridges").await;
    assert_eq!(listed.requests, vec![]);
    assert!(listed.bridges[0].open);

    // The Stage switches a channel on; the bridge shows it with its
    // default name.
    let channel = listed.bridges[0].channels[1].clone();
    stage
        .send(&ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: channel.local_mic_id,
            source: channel.source,
            switched_on: true,
        })
        .await;
    bridge
        .until("Channel multichannel.wav · Input 2: ", "on")
        .await;
    bridge.stop().await;
}
