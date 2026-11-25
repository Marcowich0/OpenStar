//! The live-state task and the WebSocket hub, driven from outside: the real
//! app in-process (through `openstar::testing::TestApp`) over real HTTP and
//! WebSocket. The placeholder state stands in for the Party until #48.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use openstar::testing::TestApp;
use openstar_protocol::{
    ChangeTopic, ClientMessage, ServerMessage, StageId, StagePlaceholder, UserMessage,
};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const WAIT: Duration = Duration::from_secs(10);

async fn connect(app: &TestApp) -> Socket {
    let (socket, _) = tokio_tungstenite::connect_async(app.ws_url())
        .await
        .expect("WebSocket connects");
    socket
}

async fn send(socket: &mut Socket, message: &ClientMessage) {
    let text = serde_json::to_string(message).unwrap();
    socket.send(Message::text(text)).await.unwrap();
}

/// The next server message, failing the test after [`WAIT`].
async fn next(socket: &mut Socket) -> ServerMessage {
    loop {
        let message = tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("a server message in time")
            .expect("the socket is open")
            .expect("a WebSocket message");
        match message {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(_) | Message::Pong(_) => {}
            other => panic!("unexpected WebSocket message {other:?}"),
        }
    }
}

/// Connects and returns the socket with the live state it was told first.
async fn connect_and_sync(app: &TestApp) -> (Socket, StageId, String) {
    let mut socket = connect(app).await;
    match next(&mut socket).await {
        ServerMessage::LiveState {
            stage_id,
            placeholder,
        } => (socket, stage_id, placeholder),
        other => panic!("expected the live state first, got {other:?}"),
    }
}

fn set(text: &str) -> ClientMessage {
    ClientMessage::SetPlaceholder {
        text: text.to_owned(),
    }
}

async fn start() -> (TestApp, tempfile::TempDir, tempfile::TempDir) {
    let (appdata, songs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let app = TestApp::start(appdata.path(), songs.path())
        .await
        .expect("app starts");
    (app, appdata, songs)
}

#[tokio::test]
async fn a_new_connection_is_told_the_current_live_state_first() {
    let (app, _appdata, _songs) = start().await;
    let (_socket, _stage_id, placeholder) = connect_and_sync(&app).await;
    assert_eq!(placeholder, "");
}

#[tokio::test]
async fn every_connection_is_attached_to_the_one_stage_id_in_use() {
    let (app, _appdata, _songs) = start().await;
    let (_a, stage_a, _) = connect_and_sync(&app).await;
    let (_b, stage_b, _) = connect_and_sync(&app).await;
    assert_eq!(stage_a, stage_b);

    let body: StagePlaceholder = reqwest::get(app.http_url("/api/placeholder"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body.stage_id, stage_a);
}

#[tokio::test]
async fn a_change_by_one_browser_reaches_every_connected_browser_as_an_event() {
    let (app, _appdata, _songs) = start().await;
    let (mut a, stage_id, _) = connect_and_sync(&app).await;
    let (mut b, _, _) = connect_and_sync(&app).await;
    let (mut c, _, _) = connect_and_sync(&app).await;

    send(&mut a, &set("Hello room")).await;

    let expected = ServerMessage::PlaceholderChanged {
        stage_id,
        placeholder: "Hello room".to_owned(),
    };
    for socket in [&mut a, &mut b, &mut c] {
        assert_eq!(next(socket).await, expected);
    }
}

#[tokio::test]
async fn a_change_notice_names_the_http_data_that_changed() {
    let (app, _appdata, _songs) = start().await;
    let (mut a, _, _) = connect_and_sync(&app).await;
    let (mut b, _, _) = connect_and_sync(&app).await;

    send(&mut a, &set("Refetch me")).await;

    assert!(matches!(
        next(&mut b).await,
        ServerMessage::PlaceholderChanged { .. }
    ));
    assert_eq!(
        next(&mut b).await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::Placeholder]
        }
    );
    let body: StagePlaceholder = reqwest::get(app.http_url("/api/placeholder"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body.placeholder, "Refetch me");
}

#[tokio::test]
async fn a_rejection_is_a_code_with_parameters_sent_only_to_the_sender() {
    let (app, _appdata, _songs) = start().await;
    let (mut a, _, _) = connect_and_sync(&app).await;
    let (mut b, _, _) = connect_and_sync(&app).await;

    send(&mut a, &set(&"x".repeat(10_000))).await;
    let rejected = next(&mut a).await;
    assert_eq!(
        serde_json::to_value(&rejected).unwrap(),
        serde_json::json!({
            "type": "rejected",
            "reason": { "code": "placeholderTooLong", "params": { "maxLength": 1000 } }
        })
    );

    // B saw nothing of it: the next thing it hears is its own ping's answer.
    send(&mut b, &ClientMessage::Ping { nonce: 9 }).await;
    assert_eq!(next(&mut b).await, ServerMessage::Pong { nonce: 9 });
}

#[tokio::test]
async fn text_that_is_not_a_client_message_is_rejected_with_a_code() {
    let (app, _appdata, _songs) = start().await;
    let (mut a, _, _) = connect_and_sync(&app).await;
    a.send(Message::text(r#"{"type":"sing"}"#)).await.unwrap();
    assert_eq!(
        next(&mut a).await,
        ServerMessage::Rejected {
            reason: UserMessage::InvalidMessage
        }
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stalled_connection_does_not_hold_back_the_others() {
    let (app, _appdata, _songs) = start().await;
    // Never read from again: its socket buffers fill up.
    let (_stalled, _, _) = connect_and_sync(&app).await;
    let (writer, _, _) = connect_and_sync(&app).await;
    let (mut reader, _, _) = connect_and_sync(&app).await;

    // About 2 × 900 bytes per change to every connection: far more than the
    // stalled socket's kernel buffers and its queue on the server hold.
    const CHANGES: usize = 3_000;
    let (mut writer_sink, mut writer_stream) = writer.split();
    let drain = tokio::spawn(async move { while writer_stream.next().await.is_some() {} });
    let sender = tokio::spawn(async move {
        for i in 0..CHANGES {
            let text = serde_json::to_string(&set(&format!("{i:0>900}"))).unwrap();
            writer_sink.send(Message::text(text)).await.unwrap();
        }
        writer_sink
    });

    let mut seen = 0;
    while seen < CHANGES {
        if let ServerMessage::PlaceholderChanged { placeholder, .. } = next(&mut reader).await {
            assert_eq!(placeholder, format!("{seen:0>900}"));
            seen += 1;
        }
    }
    drop(sender.await.unwrap());
    drain.abort();
}

#[tokio::test]
async fn the_placeholder_survives_a_restart_on_the_same_appdata_folder() {
    let (mut app, _appdata, _songs) = start().await;
    let (mut a, stage_id, _) = connect_and_sync(&app).await;
    send(&mut a, &set("Still here")).await;
    assert!(matches!(
        next(&mut a).await,
        ServerMessage::PlaceholderChanged { .. }
    ));
    let addr = app.addr();

    app.restart().await.expect("app restarts");

    // The old connection was closed by the stop, so a browser notices.
    let closed = tokio::time::timeout(WAIT, async {
        loop {
            match a.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the old connection is closed by the stop");

    // Same address, and the first thing a new connection hears is the
    // reloaded state.
    assert_eq!(app.addr(), addr);
    let (_b, stage_after, placeholder) = connect_and_sync(&app).await;
    assert_eq!(stage_after, stage_id);
    assert_eq!(placeholder, "Still here");
}

#[tokio::test]
async fn ping_is_still_answered_with_the_same_nonce() {
    let (app, _appdata, _songs) = start().await;
    let (mut a, _, _) = connect_and_sync(&app).await;
    send(&mut a, &ClientMessage::Ping { nonce: 42 }).await;
    assert_eq!(next(&mut a).await, ServerMessage::Pong { nonce: 42 });
}
