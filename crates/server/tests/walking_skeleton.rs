//! The walking skeleton (#59), driven from outside through the test harness:
//! the real axum app in-process on temporary songs and appdata folders, over
//! real HTTP and WebSocket.

use openstar_protocol::{ClientMessage, ServerInfo, ServerMessage, UserMessage};
use openstar_test_harness::TestApp;

#[tokio::test]
async fn json_endpoint_answers_with_server_info() {
    let app = TestApp::start().await;

    let info: ServerInfo = app.get_json("/api/server-info").await;
    assert_eq!(info.schema_version, openstar::db::SCHEMA_VERSION);
    assert!(!info.version.is_empty());
}

#[tokio::test]
async fn websocket_ping_gets_a_pong_with_the_same_nonce() {
    let app = TestApp::start().await;

    let mut socket = app.connect_ws().await;
    // The first message on every connection is the live state.
    assert!(matches!(
        socket.recv().await,
        ServerMessage::LiveState { .. }
    ));
    socket.send(&ClientMessage::Ping { nonce: 42 }).await;

    assert_eq!(socket.recv().await, ServerMessage::Pong { nonce: 42 });
}

#[tokio::test]
async fn startup_opens_the_database_in_wal_mode_inside_appdata() {
    let app = TestApp::start().await;

    let db = app.appdata_dir().join("openstar.db");
    assert!(db.is_file(), "database file in the appdata folder");
    let conn = rusqlite::Connection::open(&db).unwrap();
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}

#[tokio::test]
async fn a_second_start_applies_no_migrations() {
    let first = TestApp::start().await;
    assert_eq!(
        first.migrations_applied(),
        openstar::db::SCHEMA_VERSION as usize
    );

    let folders = first.stop().await;
    let second = TestApp::builder().folders(folders).start().await;
    assert_eq!(second.migrations_applied(), 0);
}

#[tokio::test]
async fn unknown_api_paths_are_not_answered_with_the_app() {
    let app = TestApp::start().await;

    let response = app.http().get(app.url("/api/nope")).send().await.unwrap();
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn a_message_that_is_not_a_client_message_is_rejected_with_a_code() {
    let app = TestApp::start().await;

    let mut socket = app.connect_ws().await;
    let _live_state = socket.recv().await;
    socket.send_text(r#"{"type":"sing"}"#).await;

    assert_eq!(
        socket.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::InvalidMessage
        }
    );
}
