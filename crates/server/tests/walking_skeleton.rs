//! The walking skeleton, driven from outside: the real axum app in-process on
//! temporary songs and appdata folders, over real HTTP and WebSocket.

use std::net::SocketAddr;
use std::path::Path;

use futures_util::{SinkExt, StreamExt};
use openstar::{Config, Server};
use openstar_protocol::{ClientMessage, ServerInfo, ServerMessage, UserMessage};
use tokio_tungstenite::tungstenite::Message;

struct Running {
    addr: SocketAddr,
    migrations_applied: usize,
}

async fn start(appdata: &Path, songs: &Path) -> Running {
    let config = Config::for_tests(appdata, songs);
    let server = Server::start(&config).await.expect("server starts");
    let migrations_applied = server.migrations_applied();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(server.serve(listener));
    Running {
        addr,
        migrations_applied,
    }
}

#[tokio::test]
async fn json_endpoint_answers_with_server_info() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let running = start(appdata.path(), songs.path()).await;

    let response = reqwest::get(format!("http://{}/api/server-info", running.addr))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let info: ServerInfo = response.json().await.unwrap();
    assert_eq!(info.schema_version, 1);
    assert!(!info.version.is_empty());
}

#[tokio::test]
async fn websocket_ping_gets_a_pong_with_the_same_nonce() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let running = start(appdata.path(), songs.path()).await;

    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", running.addr))
        .await
        .unwrap();
    // The first message on every connection is the live state.
    let first = socket.next().await.unwrap().unwrap();
    let first: ServerMessage = serde_json::from_str(first.to_text().unwrap()).unwrap();
    assert!(matches!(first, ServerMessage::LiveState { .. }));
    let ping = serde_json::to_string(&ClientMessage::Ping { nonce: 42 }).unwrap();
    socket.send(Message::text(ping)).await.unwrap();

    let answer = socket.next().await.unwrap().unwrap();
    let answer: ServerMessage = serde_json::from_str(answer.to_text().unwrap()).unwrap();
    assert_eq!(answer, ServerMessage::Pong { nonce: 42 });
}

#[tokio::test]
async fn startup_opens_the_database_in_wal_mode_inside_appdata() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let _running = start(appdata.path(), songs.path()).await;

    let db = appdata.path().join("openstar.db");
    assert!(db.is_file(), "database file in the appdata folder");
    let conn = rusqlite::Connection::open(&db).unwrap();
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}

#[tokio::test]
async fn a_second_start_applies_no_migrations() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());

    let first = start(appdata.path(), songs.path()).await;
    assert_eq!(first.migrations_applied, 1);

    let second = start(appdata.path(), songs.path()).await;
    assert_eq!(second.migrations_applied, 0);
}

#[tokio::test]
async fn unknown_api_paths_are_not_answered_with_the_app() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let running = start(appdata.path(), songs.path()).await;

    let response = reqwest::get(format!("http://{}/api/nope", running.addr))
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn a_message_that_is_not_a_client_message_is_rejected_with_a_code() {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let running = start(appdata.path(), songs.path()).await;

    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", running.addr))
        .await
        .unwrap();
    let _live_state = socket.next().await.unwrap().unwrap();
    socket
        .send(Message::text(r#"{"type":"sing"}"#))
        .await
        .unwrap();

    let answer = socket.next().await.unwrap().unwrap();
    let answer: ServerMessage = serde_json::from_str(answer.to_text().unwrap()).unwrap();
    assert_eq!(
        answer,
        ServerMessage::Rejected {
            reason: UserMessage::InvalidMessage
        }
    );
}
