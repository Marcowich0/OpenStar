//! The install script (`crates/mic-bridge/install/install.sh`), run the way
//! the Stage shows it, `curl -fsSL <address>/bridge/install.sh | sh`, in a
//! temporary HOME against the real app in-process, and the bridge's
//! `--uninstall` afterwards. Nothing here touches the real HOME.

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

use openstar_protocol::bridge::MicBridges;
use openstar_protocol::{ClientMessage, ServerMessage};
use openstar_test_harness::{TestApp, fake_mic};
use tokio::io::{AsyncBufReadExt, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::process::Command;

const BRIDGE: &str = env!("CARGO_BIN_EXE_openstar-mic-bridge");
const INSTALL_SCRIPT: &str = include_str!("../install/install.sh");
const ICON: &str = include_str!("../install/openstar-mic-bridge.svg");
const WAIT: Duration = Duration::from_secs(10);

/// A stand-in bridge that only notes that it was started.
const FAKE_BRIDGE: &str = "#!/bin/sh\necho \"started $*\" >> \"$HOME/started\"\n";

/// The files the image carries in `/usr/share/openstar/bridge/`, with
/// `binary` as the bridge.
fn bridge_folder(binary: &[u8]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("openstar-mic-bridge"), binary).unwrap();
    std::fs::write(dir.path().join("install.sh"), INSTALL_SCRIPT).unwrap();
    std::fs::write(dir.path().join("openstar-mic-bridge.svg"), ICON).unwrap();
    dir
}

/// Where the script puts things in `home`.
struct Installed {
    bin: PathBuf,
    desktop: PathBuf,
    icon: PathBuf,
    config: PathBuf,
}

fn installed(home: &Path) -> Installed {
    Installed {
        bin: home.join(".local/bin/openstar-mic-bridge"),
        desktop: home.join(".local/share/applications/openstar-mic-bridge.desktop"),
        icon: home.join(".local/share/icons/hicolor/scalable/apps/openstar-mic-bridge.svg"),
        config: home.join(".config/openstar-mic-bridge"),
    }
}

/// Runs the one-line install with only `HOME`, `PATH` and `extra` set.
async fn install(address: &str, home: &Path, extra: &[(&str, &str)]) -> Output {
    let mut command = Command::new("sh");
    command
        .args([
            "-c",
            "curl -fsSL \"$1/bridge/install.sh\" | sh",
            "sh",
            address,
        ])
        .env_clear()
        .env("HOME", home)
        .env("PATH", std::env::var("PATH").unwrap());
    for (name, value) in extra {
        command.env(name, value);
    }
    let output = tokio::time::timeout(WAIT, command.output())
        .await
        .expect("the install script ends")
        .unwrap();
    println!("{}", String::from_utf8_lossy(&output.stdout));
    eprintln!("{}", String::from_utf8_lossy(&output.stderr));
    output
}

/// Every file under `dir` and its contents, except the fake bridge's note.
fn tree(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut todo = vec![dir.to_path_buf()];
    while let Some(next) = todo.pop() {
        for entry in std::fs::read_dir(&next).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                todo.push(path);
            } else if path != dir.join("started") {
                files.insert(path.clone(), std::fs::read(&path).unwrap());
            }
        }
    }
    files
}

async fn wait_for_file(path: &Path) -> String {
    tokio::time::timeout(WAIT, async {
        loop {
            if let Ok(text) = std::fs::read_to_string(path)
                && !text.is_empty()
            {
                return text;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{} did not appear", path.display()))
}

#[tokio::test]
async fn the_script_installs_the_bridge_for_this_user_and_starts_it() {
    let folder = bridge_folder(FAKE_BRIDGE.as_bytes());
    let app = TestApp::builder().bridge_dir(folder.path()).start().await;
    let home = tempfile::tempdir().unwrap();
    let paths = installed(home.path());
    // An older install talked to another server and was approved there.
    std::fs::create_dir_all(&paths.config).unwrap();
    std::fs::write(paths.config.join("server"), "http://old.example:8080\n").unwrap();
    std::fs::write(paths.config.join("token"), "kept\n").unwrap();

    let output = install(&app.base_url(), home.path(), &[("DISPLAY", ":0")]).await;
    assert!(output.status.success());

    // The binary, executable.
    assert_eq!(std::fs::read(&paths.bin).unwrap(), FAKE_BRIDGE.as_bytes());
    let mode = std::fs::metadata(&paths.bin).unwrap().permissions().mode();
    assert_eq!(mode & 0o755, 0o755);

    // The menu entry, with absolute paths to the binary and the icon.
    let desktop = std::fs::read_to_string(&paths.desktop).unwrap();
    assert!(desktop.starts_with("[Desktop Entry]\n"), "{desktop}");
    let lines: Vec<&str> = desktop.lines().collect();
    assert!(lines.contains(&"Type=Application"), "{desktop}");
    assert!(lines.contains(&"Name=OpenStar Mic bridge"), "{desktop}");
    let exec = format!("Exec=\"{}\"", paths.bin.display());
    assert!(lines.contains(&exec.as_str()), "{desktop}");
    let icon = format!("Icon={}", paths.icon.display());
    assert!(lines.contains(&icon.as_str()), "{desktop}");
    assert_eq!(std::fs::read_to_string(&paths.icon).unwrap(), ICON);

    // This server's address replaces the old one; the token stays.
    assert_eq!(
        std::fs::read_to_string(paths.config.join("server")).unwrap(),
        format!("{}\n", app.base_url())
    );
    assert_eq!(
        std::fs::read_to_string(paths.config.join("token")).unwrap(),
        "kept\n"
    );

    // It starts the bridge, and adds no autostart entry.
    assert_eq!(
        wait_for_file(&home.path().join("started")).await,
        "started \n"
    );
    assert!(!home.path().join(".config/autostart").exists());

    // Running it again (the repair command) leaves the same result.
    let before = tree(home.path());
    let output = install(&app.base_url(), home.path(), &[("DISPLAY", ":0")]).await;
    assert!(output.status.success());
    assert_eq!(tree(home.path()), before);
}

#[tokio::test]
async fn the_script_repairs_a_broken_install() {
    let folder = bridge_folder(FAKE_BRIDGE.as_bytes());
    let app = TestApp::builder().bridge_dir(folder.path()).start().await;
    let home = tempfile::tempdir().unwrap();
    let paths = installed(home.path());
    assert!(
        install(&app.base_url(), home.path(), &[])
            .await
            .status
            .success()
    );

    std::fs::write(&paths.bin, "truncated").unwrap();
    std::fs::remove_file(&paths.desktop).unwrap();
    std::fs::remove_file(paths.config.join("server")).unwrap();
    assert!(
        install(&app.base_url(), home.path(), &[])
            .await
            .status
            .success()
    );

    assert_eq!(std::fs::read(&paths.bin).unwrap(), FAKE_BRIDGE.as_bytes());
    assert!(paths.desktop.is_file());
    assert!(paths.config.join("server").is_file());
}

#[tokio::test]
async fn without_a_desktop_session_it_installs_but_does_not_start_the_bridge() {
    let folder = bridge_folder(FAKE_BRIDGE.as_bytes());
    let app = TestApp::builder().bridge_dir(folder.path()).start().await;
    let home = tempfile::tempdir().unwrap();

    let output = install(&app.base_url(), home.path(), &[]).await;
    assert!(output.status.success());
    assert!(installed(home.path()).bin.is_file());
    let said = String::from_utf8(output.stdout).unwrap();
    assert!(said.contains("app menu"), "{said}");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!home.path().join("started").exists());
}

/// A bare HTTP server that answers each path `files` gives for its own
/// address, and 404 otherwise.
async fn serve_files(files: impl FnOnce(&str) -> BTreeMap<&'static str, Vec<u8>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let files = files(&address);
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let files = files.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buffer = [0_u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    let read = socket.read(&mut buffer).await.unwrap();
                    if read == 0 {
                        return;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                let path = String::from_utf8_lossy(&request)
                    .split(' ')
                    .nth(1)
                    .unwrap_or_default()
                    .to_owned();
                let (status, body) = match files.get(path.as_str()) {
                    Some(body) => ("200 OK", body.clone()),
                    None => ("404 Not Found", Vec::new()),
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(head.as_bytes()).await.unwrap();
                socket.write_all(&body).await.unwrap();
            });
        }
    });
    address
}

#[tokio::test]
async fn a_binary_that_does_not_match_the_servers_checksum_is_not_installed() {
    let address = serve_files(|address| {
        BTreeMap::from([
            (
                "/bridge/install.sh",
                INSTALL_SCRIPT
                    .replace("@OPENSTAR_SERVER@", address)
                    .into_bytes(),
            ),
            (
                "/bridge/openstar-mic-bridge",
                FAKE_BRIDGE.as_bytes().to_vec(),
            ),
            (
                "/bridge/openstar-mic-bridge.sha256",
                format!("{}  openstar-mic-bridge\n", "0".repeat(64)).into_bytes(),
            ),
            ("/bridge/openstar-mic-bridge.svg", ICON.as_bytes().to_vec()),
        ])
    })
    .await;
    let home = tempfile::tempdir().unwrap();

    let output = install(&address, home.path(), &[("DISPLAY", ":0")]).await;
    assert!(!output.status.success());
    let said = String::from_utf8(output.stderr).unwrap();
    assert!(said.contains("SHA-256"), "{said}");
    // Nothing was installed or started, and no partial download is left.
    let paths = installed(home.path());
    assert!(!paths.bin.exists());
    assert!(!paths.desktop.exists());
    assert!(!paths.config.join("server").exists());
    assert_eq!(tree(home.path()), BTreeMap::new());
    assert!(!home.path().join("started").exists());
}

#[tokio::test]
async fn run_from_the_repo_without_an_address_the_script_refuses() {
    let home = tempfile::tempdir().unwrap();
    let output = std::process::Command::new("sh")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("install/install.sh"))
        .env_clear()
        .env("HOME", home.path())
        .env("PATH", std::env::var("PATH").unwrap())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(tree(home.path()), BTreeMap::new());
}

async fn open_stage(app: &TestApp) -> openstar_test_harness::WsClient {
    let mut stage = app.connect_stage().await;
    assert!(matches!(
        stage.recv().await,
        ServerMessage::LiveState { is_stage: true, .. }
    ));
    stage
}

#[tokio::test]
async fn uninstall_removes_what_the_script_installed_and_the_bridge_stays_approved_and_closed() {
    let folder = bridge_folder(&std::fs::read(BRIDGE).unwrap());
    let app = TestApp::builder().bridge_dir(folder.path()).start().await;
    let home = tempfile::tempdir().unwrap();
    let paths = installed(home.path());
    assert!(
        install(&app.base_url(), home.path(), &[])
            .await
            .status
            .success()
    );

    // The installed bridge joins and is approved.
    let stage = open_stage(&app).await;
    let mic = tempfile::tempdir().unwrap();
    let wav = fake_mic::write(mic.path()).unwrap().multichannel;
    let mut bridge = Command::new(&paths.bin)
        .arg("--wav")
        .arg(&wav)
        .env_clear()
        .env("HOME", home.path())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(bridge.stdout.take().unwrap()).lines();
    let mut stage = stage;
    let request_id = tokio::time::timeout(WAIT, async {
        loop {
            let listed: MicBridges = app.get_json("/api/mic-bridges").await;
            if let Some(request) = listed.requests.first() {
                return request.request_id;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the installed bridge asks to join");
    stage
        .send(&ClientMessage::ApproveBridge { request_id })
        .await;
    tokio::time::timeout(WAIT, async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if line == "Connected" {
                return;
            }
        }
        panic!("the bridge ended before it connected");
    })
    .await
    .expect("the bridge connects");
    assert!(paths.config.join("token").is_file());
    bridge.kill().await.unwrap();

    let output = Command::new(&paths.bin)
        .arg("--uninstall")
        .env_clear()
        .env("HOME", home.path())
        .output()
        .await
        .unwrap();
    println!("{}", String::from_utf8_lossy(&output.stdout));
    eprintln!("{}", String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success());
    assert!(!paths.bin.exists());
    assert!(!paths.desktop.exists());
    assert!(!paths.icon.exists());
    assert!(!paths.config.exists());

    // Still approved on the server, shown as closed.
    let listed = tokio::time::timeout(WAIT, async {
        loop {
            let listed: MicBridges = app.get_json("/api/mic-bridges").await;
            if listed.bridges.iter().all(|bridge| !bridge.open) {
                return listed;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the bridge shows as closed");
    assert_eq!(listed.bridges.len(), 1);
    assert_eq!(listed.requests, vec![]);
}
