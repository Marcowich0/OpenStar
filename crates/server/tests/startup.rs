//! Startup checks, `/healthz` and the server-info response, driven from
//! outside: the real axum app in-process on temporary songs and appdata
//! folders, over real HTTP.

use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use openstar::{Config, Server};
use openstar_protocol::{LibraryReadOnly, LibraryReadOnlyCode, ServerInfo};

async fn serve(config: &Config) -> SocketAddr {
    let server = Server::start(config).await.expect("server starts");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(server.serve(listener));
    addr
}

async fn server_info(addr: SocketAddr) -> ServerInfo {
    let response = reqwest::get(format!("http://{addr}/api/server-info"))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.json().await.unwrap()
}

/// Makes `dir` read-only. Returns false when the process can still write
/// there anyway (running as root), so the caller can skip its test.
fn make_read_only(dir: &Path) -> bool {
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    let probe = dir.join("probe");
    if std::fs::write(&probe, b"x").is_ok() {
        let _ = std::fs::remove_file(probe);
        eprintln!("skipping: this process can write to read-only folders (root?)");
        return false;
    }
    true
}

fn make_writable(dir: &Path) {
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[tokio::test]
async fn healthz_answers_success_once_serving() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let addr = serve(&Config::for_tests(appdata.path(), songs.path())).await;

    let response = reqwest::get(format!("http://{addr}/healthz"))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn server_info_reports_the_build_identifier_and_join_address_inputs() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut config = Config::for_tests(appdata.path(), songs.path());
    config.public_url = Some("https://openstar.example.org".to_owned());
    let addr = serve(&config).await;

    let info = server_info(addr).await;
    assert_eq!(info.version, openstar::BUILD_ID);
    assert_eq!(
        info.public_url.as_deref(),
        Some("https://openstar.example.org")
    );
    assert_eq!(info.library_read_only, None);
}

#[tokio::test]
async fn without_a_public_url_the_join_address_input_is_null() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let addr = serve(&Config::for_tests(appdata.path(), songs.path())).await;

    let body: serde_json::Value = reqwest::get(format!("http://{addr}/api/server-info"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["publicUrl"], serde_json::Value::Null);
    assert_eq!(body["libraryReadOnly"], serde_json::Value::Null);
}

#[tokio::test]
async fn an_unwritable_appdata_folder_refuses_to_start_before_the_database() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    if !make_read_only(appdata.path()) {
        return;
    }

    let result = Server::start(&Config::for_tests(appdata.path(), songs.path())).await;
    make_writable(appdata.path());

    let message = format!("{:#}", result.err().expect("start fails"));
    assert!(message.contains("appdata folder"), "{message}");
    assert!(
        message.contains(&appdata.path().display().to_string()),
        "{message}"
    );
    assert!(!appdata.path().join("openstar.db").exists());
}

#[tokio::test]
async fn a_missing_appdata_folder_refuses_to_start() {
    let parent = tempfile::tempdir().unwrap();
    let songs = tempfile::tempdir().unwrap();
    let appdata = parent.path().join("absent");

    let result = Server::start(&Config::for_tests(&appdata, songs.path())).await;
    let message = format!("{:#}", result.err().expect("start fails"));
    assert!(message.contains("appdata folder"), "{message}");
}

#[tokio::test]
async fn a_read_only_songs_folder_starts_with_a_read_only_library() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    if !make_read_only(songs.path()) {
        return;
    }

    let config = Config::for_tests(appdata.path(), songs.path());
    let server = Server::start(&config).await;
    make_writable(songs.path());
    let server = server.expect("a read-only songs folder still starts");

    let expected = LibraryReadOnly {
        code: LibraryReadOnlyCode::SongsFolderNotWritable,
        songs_dir: songs.path().display().to_string(),
    };
    assert_eq!(server.library_read_only(), Some(&expected));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(server.serve(listener));
    let body: serde_json::Value = reqwest::get(format!("http://{addr}/api/server-info"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // A code plus parameters, not English.
    assert_eq!(
        body["libraryReadOnly"],
        serde_json::json!({
            "code": "songsFolderNotWritable",
            "songsDir": songs.path().display().to_string(),
        })
    );
}

#[tokio::test]
async fn a_missing_songs_folder_starts_with_a_read_only_library() {
    let appdata = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let songs = parent.path().join("absent");

    let addr = serve(&Config::for_tests(appdata.path(), &songs)).await;
    let info = server_info(addr).await;
    assert_eq!(
        info.library_read_only.map(|r| r.code),
        Some(LibraryReadOnlyCode::SongsFolderMissing)
    );
}

#[tokio::test]
async fn the_write_checks_leave_no_files_behind() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let _addr = serve(&Config::for_tests(appdata.path(), songs.path())).await;

    assert_eq!(std::fs::read_dir(songs.path()).unwrap().count(), 0);
    let leftovers: Vec<_> = std::fs::read_dir(appdata.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|name| !name.starts_with("openstar.db"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}
