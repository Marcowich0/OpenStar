//! The live-state task and the WebSocket hub, driven from outside through
//! the test harness: the real app in-process over real HTTP and WebSocket.

use futures_util::{SinkExt, StreamExt};
use openstar_protocol::{ClientMessage, PartySnapshot, ServerMessage, StageId, UserMessage};
use openstar_test_harness::{TestApp, WsClient};
use tokio_tungstenite::tungstenite::Message;

/// What a connection is told first.
struct Synced {
    socket: WsClient,
    stage_id: StageId,
    party: Option<PartySnapshot>,
}

async fn sync(mut socket: WsClient) -> Synced {
    match socket.recv().await {
        ServerMessage::LiveState {
            stage_id, party, ..
        } => Synced {
            socket,
            stage_id,
            party,
        },
        other => panic!("expected the live state first, got {other:?}"),
    }
}

/// Opens the Stage and reads up to the Party it started.
async fn open_stage(app: &TestApp) -> WsClient {
    let mut stage = sync(app.connect_stage().await).await.socket;
    assert!(matches!(
        stage.recv().await,
        ServerMessage::PartyChanged { .. }
    ));
    stage
}

#[tokio::test]
async fn a_new_connection_is_told_the_current_live_state_first() {
    let app = TestApp::start().await;
    let synced = sync(app.connect_ws().await).await;
    // No Stage has opened yet on this fresh server, so there is no Party.
    assert_eq!(synced.party, None);
}

#[tokio::test]
async fn every_connection_is_attached_to_the_one_stage_id_in_use() {
    let app = TestApp::start().await;
    let a = sync(app.connect_ws().await).await;
    let b = sync(app.connect_stage().await).await;
    assert_eq!(a.stage_id, b.stage_id);
}

#[tokio::test]
async fn text_that_is_not_a_client_message_is_rejected_with_a_code() {
    let app = TestApp::start().await;
    let mut a = sync(app.connect_ws().await).await.socket;
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
    let mut stalled = sync(app.connect_ws().await).await.socket;
    let stage = open_stage(&app).await;
    let mut reader = sync(app.connect_ws().await).await.socket;

    // About 300 bytes per change to every connection: more than the stalled
    // socket's kernel buffers and its queue on the server hold.
    const CHANGES: usize = 12_000;
    let (mut stage_sink, mut stage_stream) = stage.into_socket().split();
    let drain = tokio::spawn(async move { while stage_stream.next().await.is_some() {} });
    let sender = tokio::spawn(async move {
        let text = serde_json::to_string(&ClientMessage::NewParty).unwrap();
        for _ in 0..CHANGES {
            stage_sink.send(Message::text(text.clone())).await.unwrap();
        }
        stage_sink
    });

    let mut seen = 0;
    let mut previous = None;
    while seen < CHANGES {
        if let ServerMessage::PartyChanged { party, .. } = reader.recv().await {
            assert_ne!(Some(&party.party_id), previous.as_ref());
            previous = Some(party.party_id);
            seen += 1;
        }
    }
    drop(sender.await.unwrap());
    drain.abort();
    // The server gave up on the stalled connection and closed it.
    stalled.closed().await;
}

#[tokio::test]
async fn stopping_closes_every_websocket() {
    let app = TestApp::start().await;
    let mut a = sync(app.connect_ws().await).await.socket;
    let mut b = open_stage(&app).await;
    let _folders = app.stop().await;
    a.closed().await;
    b.closed().await;
}

#[tokio::test]
async fn ping_is_still_answered_with_the_same_nonce() {
    let app = TestApp::start().await;
    let mut a = sync(app.connect_ws().await).await.socket;
    a.send(&ClientMessage::Ping { nonce: 42 }).await;
    assert_eq!(a.recv().await, ServerMessage::Pong { nonce: 42 });
}
