//! The app's routes and the server's own `/bridge/` files, over real HTTP.
//!
//! The frontend may not be built when these run, so "served the app" is
//! checked by comparing with the answer for `/`, whatever that is.

use std::net::SocketAddr;
use std::path::Path;

use openstar::{Config, Server};

async fn start(appdata: &Path, songs: &Path, bridge: &Path) -> SocketAddr {
    let config = Config {
        port: 0,
        appdata_dir: appdata.to_path_buf(),
        songs_dir: songs.to_path_buf(),
    };
    let server = Server::start(&config)
        .await
        .expect("server starts")
        .with_bridge_dir(bridge);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(server.serve(listener));
    addr
}

async fn get(addr: SocketAddr, path: &str) -> (u16, String) {
    let response = reqwest::get(format!("http://{addr}{path}")).await.unwrap();
    let status = response.status().as_u16();
    (status, response.text().await.unwrap())
}

struct Dirs {
    appdata: tempfile::TempDir,
    songs: tempfile::TempDir,
    bridge: tempfile::TempDir,
}

fn dirs() -> Dirs {
    Dirs {
        appdata: tempfile::tempdir().unwrap(),
        songs: tempfile::tempdir().unwrap(),
        bridge: tempfile::tempdir().unwrap(),
    }
}

#[tokio::test]
async fn a_reload_on_any_route_is_served_the_app() {
    let d = dirs();
    let addr = start(d.appdata.path(), d.songs.path(), d.bridge.path()).await;
    let app = get(addr, "/").await;

    for path in [
        "/stage",
        "/admin",
        "/admin/downloads",
        "/admin/songs",
        "/admin/library-problems",
        "/admin/profiles",
        "/bridge",
        "/?join=1234",
    ] {
        assert_eq!(get(addr, path).await, app, "{path} is served the app");
    }
}

#[tokio::test]
async fn the_servers_own_bridge_files_take_precedence_over_the_app() {
    let d = dirs();
    std::fs::write(
        d.bridge.path().join("install.sh"),
        "#!/bin/sh\necho placeholder\n",
    )
    .unwrap();
    let addr = start(d.appdata.path(), d.songs.path(), d.bridge.path()).await;

    let (status, body) = get(addr, "/bridge/install.sh").await;
    assert_eq!(status, 200);
    assert_eq!(body, "#!/bin/sh\necho placeholder\n");
}

#[tokio::test]
async fn a_bridge_path_with_no_file_falls_back_to_the_app() {
    let d = dirs();
    let addr = start(d.appdata.path(), d.songs.path(), d.bridge.path()).await;
    let app = get(addr, "/").await;

    assert_eq!(get(addr, "/bridge/nothing-here").await, app);
}

#[tokio::test]
async fn bridge_files_never_reach_outside_the_bridge_folder() {
    let d = dirs();
    let bridge = d.bridge.path().join("bridge");
    std::fs::create_dir(&bridge).unwrap();
    std::fs::write(d.bridge.path().join("secret.txt"), "secret").unwrap();
    let addr = start(d.appdata.path(), d.songs.path(), &bridge).await;

    for path in [
        "/bridge/../secret.txt",
        "/bridge/%2e%2e/secret.txt",
        "/bridge/..%2fsecret.txt",
    ] {
        let (_, body) = get(addr, path).await;
        assert_ne!(body, "secret", "{path}");
    }
}
