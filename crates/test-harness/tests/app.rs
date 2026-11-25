//! The in-process app: its own folders, port, database and settings.

use openstar_protocol::ServerInfo;
use openstar_test_harness::{
    FAKE_USDB_PASSWORD, FAKE_USDB_USERNAME, FakeUsdb, TestApp, USDB_BASE_URL_VAR, YtDlpStub,
};

#[tokio::test]
async fn starts_on_fresh_folders_with_a_chosen_admin_pin_and_a_base_url() {
    let app = TestApp::builder().admin_pin("482916").start().await;

    assert_eq!(app.var("OPENSTAR_ADMIN_PIN"), Some("482916"));
    assert_eq!(app.var("OPENSTAR_SONGS_DIR"), app.songs_dir().to_str());
    assert_eq!(app.var("OPENSTAR_APPDATA_DIR"), app.appdata_dir().to_str());
    assert_eq!(
        std::fs::read_dir(app.songs_dir()).unwrap().count(),
        0,
        "the songs folder starts empty"
    );
    assert!(app.base_url().starts_with("http://127.0.0.1:"));
    assert_eq!(
        app.var("OPENSTAR_PORT").unwrap(),
        app.addr().port().to_string()
    );
    let info: ServerInfo = app.get_json("/api/server-info").await;
    assert_eq!(info.schema_version, openstar::db::SCHEMA_VERSION);
}

#[tokio::test(flavor = "multi_thread")]
async fn apps_in_parallel_share_no_folders_ports_or_databases() {
    let apps = futures_util::future::join_all((0..4).map(|_| TestApp::start())).await;

    for (i, a) in apps.iter().enumerate() {
        for b in &apps[i + 1..] {
            assert_ne!(a.addr(), b.addr());
            assert_ne!(a.songs_dir(), b.songs_dir());
            assert_ne!(a.appdata_dir(), b.appdata_dir());
        }
        assert_eq!(
            a.migrations_applied(),
            openstar::db::SCHEMA_VERSION as usize,
            "each app has a new database"
        );
        assert!(a.appdata_dir().join("openstar.db").is_file());
        let _: ServerInfo = a.get_json("/api/server-info").await;
    }
}

#[tokio::test]
async fn folders_are_removed_when_the_app_is_dropped() {
    let app = TestApp::start().await;
    let (songs, appdata) = (
        app.songs_dir().to_path_buf(),
        app.appdata_dir().to_path_buf(),
    );
    drop(app);
    assert!(!songs.exists() && !appdata.exists());
}

#[tokio::test]
async fn without_a_fake_usdb_the_app_points_usdb_at_a_closed_local_port() {
    let app = TestApp::builder()
        .var("OPENSTAR_USDB_USERNAME", "real-user")
        .var("OPENSTAR_USDB_PASSWORD", "real-password")
        .var(USDB_BASE_URL_VAR, "https://usdb.animux.de")
        .start()
        .await;

    assert_eq!(app.var(USDB_BASE_URL_VAR), Some("http://127.0.0.1:9"));
    assert_eq!(app.var("OPENSTAR_USDB_USERNAME"), None);
    assert_eq!(app.var("OPENSTAR_USDB_PASSWORD"), None);
}

#[tokio::test]
async fn with_a_fake_usdb_the_app_points_usdb_at_it_with_fake_credentials() {
    let usdb = FakeUsdb::start().await;
    let app = TestApp::builder().usdb(&usdb).start().await;

    assert_eq!(app.var(USDB_BASE_URL_VAR), Some(usdb.base_url().as_str()));
    assert_eq!(app.var("OPENSTAR_USDB_USERNAME"), Some(FAKE_USDB_USERNAME));
    assert_eq!(app.var("OPENSTAR_USDB_PASSWORD"), Some(FAKE_USDB_PASSWORD));
}

#[tokio::test]
async fn the_ytdlp_stub_comes_first_on_the_apps_path() {
    let stub = YtDlpStub::new();
    let app = TestApp::builder().ytdlp_stub(&stub).start().await;

    let path = app.var("PATH").unwrap();
    let first = std::env::split_paths(path).next().unwrap();
    assert_eq!(first, stub.dir());
    assert_eq!(app.var("OPENSTAR_YTDLP_AUTOUPDATE"), Some("false"));
}
