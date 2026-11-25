//! One WebSocket connection: forwards what the browser sends to the
//! live-state task as commands and writes what the hub queues for it. It holds
//! no live state and no lock.

use axum::extract::ws::{Message, WebSocket};
use openstar_protocol::ClientMessage;

use super::LiveHandle;

pub async fn run(mut socket: WebSocket, live: LiveHandle) {
    let Some(mut connection) = live.connect().await else {
        return;
    };
    let id = connection.id;
    loop {
        tokio::select! {
            _ = &mut connection.dropped => break,
            outgoing = connection.outgoing.recv() => {
                let Some(text) = outgoing else { break };
                // A stalled socket must not keep a dropped connection alive.
                tokio::select! {
                    sent = socket.send(Message::Text(text)) => if sent.is_err() { break },
                    _ = &mut connection.dropped => break,
                }
            }
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let message = serde_json::from_str::<ClientMessage>(&text).map_err(|error| {
                        tracing::debug!(%error, "rejecting a WebSocket message that is not a ClientMessage");
                    });
                    if !live.received(id, message).await {
                        break;
                    }
                }
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
    live.disconnect(id).await;
}
