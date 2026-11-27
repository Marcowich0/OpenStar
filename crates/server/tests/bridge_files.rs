//! The Mic bridge files under `/bridge/`: the binary, its SHA-256 and the
//! install script with the server's address filled in, all without a PIN.

use std::net::SocketAddr;

use openstar::{Config, Server};
use sha2::{Digest, Sha256};

/// The repo's install script, one of the files the image carries.
const INSTALL_SCRIPT: &str = include_str!("../../mic-bridge/install/install.sh");

struct Running {
    addr: SocketAddr,
    _dirs: [tempfile::TempDir; 3],
}

/// A server whose bridge folder holds `binary` and the repo's install script.
async fn start(binary: &[u8], public_url: Option<&str>) -> Running {
    let appdata = tempfile::tempdir().unwrap();
    let songs = tempfile::tempdir().unwrap();
    let bridge = tempfile::tempdir().unwrap();
    std::fs::write(bridge.path().join("openstar-mic-bridge"), binary).unwrap();
    std::fs::write(bridge.path().join("install.sh"), INSTALL_SCRIPT).unwrap();
    let mut config = Config::for_tests(appdata.path(), songs.path());
    config.public_url = public_url.map(str::to_owned);
    let server = Server::start(&config)
        .await
        .expect("server starts")
        .with_bridge_dir(bridge.path());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(server.serve(listener));
    Running {
        addr,
        _dirs: [appdata, songs, bridge],
    }
}

/// A plain GET, with no cookie and no PIN.
async fn get(addr: SocketAddr, path: &str, headers: &[(&str, &str)]) -> reqwest::Response {
    let mut request = reqwest::Client::new().get(format!("http://{addr}{path}"));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    request.send().await.unwrap()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn server_line(script: &str) -> &str {
    script
        .lines()
        .find(|line| line.starts_with("server="))
        .expect("the script sets its server address")
}

#[tokio::test]
async fn the_binary_and_its_checksum_are_served_without_a_pin_and_match() {
    let binary = b"\x7fELF pretend bridge build".repeat(1000);
    let app = start(&binary, None).await;

    let response = get(app.addr, "/bridge/openstar-mic-bridge", &[]).await;
    assert_eq!(response.status(), 200);
    let served = response.bytes().await.unwrap();
    assert_eq!(&served[..], &binary[..]);

    let response = get(app.addr, "/bridge/openstar-mic-bridge.sha256", &[]).await;
    assert_eq!(response.status(), 200);
    let checksum = response.text().await.unwrap();
    let expected = hex(&Sha256::digest(&served));
    assert_eq!(checksum, format!("{expected}  openstar-mic-bridge\n"));
}

#[tokio::test]
async fn the_checksum_follows_the_binary_not_a_stale_checksum_file() {
    let app = start(b"new build", None).await;
    let dir = &app._dirs[2];
    std::fs::write(
        dir.path().join("openstar-mic-bridge.sha256"),
        "0000  openstar-mic-bridge\n",
    )
    .unwrap();

    let checksum = get(app.addr, "/bridge/openstar-mic-bridge.sha256", &[])
        .await
        .text()
        .await
        .unwrap();
    assert!(checksum.starts_with(&hex(&Sha256::digest(b"new build"))));
}

#[tokio::test]
async fn without_a_bridge_binary_there_is_no_checksum() {
    let app = start(b"", None).await;
    std::fs::remove_file(app._dirs[2].path().join("openstar-mic-bridge")).unwrap();

    let response = get(app.addr, "/bridge/openstar-mic-bridge.sha256", &[]).await;
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn the_install_script_is_served_with_the_public_url_when_it_is_set() {
    let app = start(b"bin", Some("https://openstar.example.org")).await;

    let response = get(app.addr, "/bridge/install.sh", &[]).await;
    assert_eq!(response.status(), 200);
    let script = response.text().await.unwrap();
    assert!(script.starts_with("#!/bin/sh\n"));
    assert_eq!(
        server_line(&script),
        "server='https://openstar.example.org'"
    );
}

#[tokio::test]
async fn the_install_script_is_served_with_the_address_it_was_fetched_from_otherwise() {
    let app = start(b"bin", None).await;

    let script = get(app.addr, "/bridge/install.sh", &[])
        .await
        .text()
        .await
        .unwrap();
    assert_eq!(
        server_line(&script),
        format!("server='http://{}'", app.addr)
    );

    // Behind an HTTPS proxy that says so.
    let script = get(
        app.addr,
        "/bridge/install.sh",
        &[
            ("host", "karaoke.example:8443"),
            ("x-forwarded-proto", "https"),
        ],
    )
    .await
    .text()
    .await
    .unwrap();
    assert_eq!(
        server_line(&script),
        "server='https://karaoke.example:8443'"
    );
}

#[tokio::test]
async fn a_host_that_is_not_a_plain_address_never_reaches_the_script() {
    let app = start(b"bin", None).await;

    for host in ["evil'$(rm -rf ~)'", "a b", "x\"y"] {
        let response = get(app.addr, "/bridge/install.sh", &[("host", host)]).await;
        assert_eq!(response.status(), 400, "{host}");
        // Codes, not English: a bare 400.
        assert_eq!(response.text().await.unwrap(), "", "{host}");
    }
}

#[test]
fn the_repo_install_script_waits_for_its_address() {
    // Run straight from the repo, the script has no address and refuses.
    assert!(INSTALL_SCRIPT.contains("server='@OPENSTAR_SERVER@'"));
}
