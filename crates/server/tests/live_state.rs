//! The live-state task and the WebSocket hub, driven from outside through
//! the test harness: the real app in-process over real HTTP and WebSocket.
//! The placeholder state stands in for the Party until #48.

use futures_util::{SinkExt, StreamExt};
use openstar_protocol::{
    ChangeTopic, ClientMessage, ServerMessage, StageId, StagePlaceholder, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};
use tokio_tungstenite::tungstenite::Message;

/// Connects and returns the socket with the live state it was told first.
async fn connect_and_sync(app: &TestApp) -> (WsClient, StageId, String) {
    let mut socket = app.connect_ws().await;
    match socket.recv().await {
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

#[tokio::test]
async fn a_new_connection_is_told_the_current_live_state_first() {
    let app = TestApp::start().await;
    let (_socket, _stage_id, placeholder) = connect_and_sync(&app).await;
    assert_eq!(placeholder, "");
}

#[tokio::test]
async fn every_connection_is_attached_to_the_one_stage_id_in_use() {
    let app = TestApp::start().await;
    let (_a, stage_a, _) = connect_and_sync(&app).await;
    let (_b, stage_b, _) = connect_and_sync(&app).await;
    assert_eq!(stage_a, stage_b);

    let body: StagePlaceholder = app.get_json("/api/placeholder").await;
    assert_eq!(body.stage_id, stage_a);
}

#[tokio::test]
async fn a_change_by_one_browser_reaches_every_connected_browser_as_an_event() {
    let app = TestApp::start().await;
    let (mut a, stage_id, _) = connect_and_sync(&app).await;
    let (mut b, _, _) = connect_and_sync(&app).await;
    let (mut c, _, _) = connect_and_sync(&app).await;

    a.send(&set("Hello room")).await;

    let expected = ServerMessage::PlaceholderChanged {
        stage_id,
        placeholder: "Hello room".to_owned(),
    };
    for socket in [&mut a, &mut b, &mut c] {
        assert_eq!(socket.recv().await, expected);
    }
}

#[tokio::test]
async fn a_change_notice_names_the_http_data_that_changed() {
    let app = TestApp::start().await;
    let (mut a, _, _) = connect_and_sync(&app).await;
    let (mut b, _, _) = connect_and_sync(&app).await;

    a.send(&set("Refetch me")).await;

    assert!(matches!(
        b.recv().await,
        ServerMessage::PlaceholderChanged { .. }
    ));
    assert_eq!(
        b.recv().await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::Placeholder]
        }
    );
    let body: StagePlaceholder = app.get_json("/api/placeholder").await;
    assert_eq!(body.placeholder, "Refetch me");
}

#[tokio::test]
async fn a_rejection_is_a_code_with_parameters_sent_only_to_the_sender() {
    let app = TestApp::start().await;
    let (mut a, _, _) = connect_and_sync(&app).await;
    let (mut b, _, _) = connect_and_sync(&app).await;

    a.send(&set(&"x".repeat(10_000))).await;
    assert_eq!(
        serde_json::to_value(a.recv().await).unwrap(),
        serde_json::json!({
            "type": "rejected",
            "reason": { "code": "placeholderTooLong", "params": { "maxLength": 1000 } }
        })
    );

    // B saw nothing of it: the next thing it hears is its own ping's answer.
    b.send(&ClientMessage::Ping { nonce: 9 }).await;
    assert_eq!(b.recv().await, ServerMessage::Pong { nonce: 9 });
}

#[tokio::test]
async fn text_that_is_not_a_client_message_is_rejected_with_a_code() {
    let app = TestApp::start().await;
    let (mut a, _, _) = connect_and_sync(&app).await;
    a.send_text(r#"{"type":"sing"}"#).await;
    assert_eq!(
        a.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::InvalidMessage
        }
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stalled_connection_does_not_hold_back_the_others() {
    let app = TestApp::start().await;
    // Never read from again: its socket buffers fill up.
    let (_stalled, _, _) = connect_and_sync(&app).await;
    let (writer, _, _) = connect_and_sync(&app).await;
    let (mut reader, _, _) = connect_and_sync(&app).await;

    // About 2 × 900 bytes per change to every connection: far more than the
    // stalled socket's kernel buffers and its queue on the server hold.
    const CHANGES: usize = 3_000;
    let (mut writer_sink, mut writer_stream) = writer.into_socket().split();
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
        if let ServerMessage::PlaceholderChanged { placeholder, .. } = reader.recv().await {
            assert_eq!(placeholder, format!("{seen:0>900}"));
            seen += 1;
        }
    }
    drop(sender.await.unwrap());
    drain.abort();
}

#[tokio::test]
async fn the_placeholder_survives_a_restart_on_the_same_appdata_folder() {
    let mut app = TestApp::start().await;
    let (mut a, stage_id, _) = connect_and_sync(&app).await;
    a.send(&set("Still here")).await;
    assert!(matches!(
        a.recv().await,
        ServerMessage::PlaceholderChanged { .. }
    ));
    let addr = app.addr();

    app.restart().await;

    // The stop closed the old connection, so a browser notices and reconnects
    // to the same address; the first thing it hears is the reloaded state.
    a.closed().await;
    assert_eq!(app.addr(), addr);
    let (_b, stage_after, placeholder) = connect_and_sync(&app).await;
    assert_eq!(stage_after, stage_id);
    assert_eq!(placeholder, "Still here");
}

#[tokio::test]
async fn stopping_closes_every_websocket() {
    let app = TestApp::start().await;
    let (mut a, _, _) = connect_and_sync(&app).await;
    let (mut b, _, _) = connect_and_sync(&app).await;
    let _folders = app.stop().await;
    a.closed().await;
    b.closed().await;
}

#[tokio::test]
async fn ping_is_still_answered_with_the_same_nonce() {
    let app = TestApp::start().await;
    let (mut a, _, _) = connect_and_sync(&app).await;
    a.send(&ClientMessage::Ping { nonce: 42 }).await;
    assert_eq!(a.recv().await, ServerMessage::Pong { nonce: 42 });
}
