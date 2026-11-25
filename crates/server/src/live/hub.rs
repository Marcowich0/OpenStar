//! The WebSocket hub: one entry per connected browser, owned by the
//! live-state task (so it needs no lock). It sends a message to one
//! connection or to all of them without ever waiting on a socket.

use std::collections::HashMap;

use axum::extract::ws::Utf8Bytes;
use openstar_protocol::ServerMessage;
use tokio::sync::{mpsc, oneshot};

/// How many messages may wait for one connection. A connection that falls
/// this far behind is dropped (its browser reconnects and is told the whole
/// state again), so it never holds back the others.
pub const OUTGOING_CAPACITY: usize = 1024;

/// Identifies one WebSocket connection while it is open.
pub type ConnectionId = u64;

/// The connection handler's end of a hub entry.
pub struct Connection {
    pub id: ConnectionId,
    /// Messages to write to the socket, already encoded as JSON.
    pub outgoing: mpsc::Receiver<Utf8Bytes>,
    /// Completes (with an error) when the hub drops the connection: the
    /// handler closes the socket at once, even mid-write.
    pub dropped: oneshot::Receiver<()>,
}

struct Entry {
    outgoing: mpsc::Sender<Utf8Bytes>,
    /// Dropping it completes the handler's `dropped`.
    _drop_signal: oneshot::Sender<()>,
}

#[derive(Default)]
pub struct Hub {
    next_id: ConnectionId,
    connections: HashMap<ConnectionId, Entry>,
}

impl Hub {
    /// Adds a connection.
    pub fn add(&mut self) -> Connection {
        let id = self.next_id;
        self.next_id += 1;
        let (outgoing_tx, outgoing) = mpsc::channel(OUTGOING_CAPACITY);
        let (drop_signal, dropped) = oneshot::channel();
        self.connections.insert(
            id,
            Entry {
                outgoing: outgoing_tx,
                _drop_signal: drop_signal,
            },
        );
        Connection {
            id,
            outgoing,
            dropped,
        }
    }

    /// Forgets a connection; its handler closes the socket.
    pub fn remove(&mut self, id: ConnectionId) {
        self.connections.remove(&id);
    }

    /// Sends `message` to one connection.
    pub fn send_to(&mut self, id: ConnectionId, message: &ServerMessage) {
        if let Some(text) = encode(message) {
            self.deliver(id, text);
        }
    }

    /// Sends `message` to every connection, encoding it once.
    pub fn send_all(&mut self, message: &ServerMessage) {
        let Some(text) = encode(message) else {
            return;
        };
        let ids: Vec<ConnectionId> = self.connections.keys().copied().collect();
        for id in ids {
            self.deliver(id, text.clone());
        }
    }

    /// Queues `text` without waiting; drops a connection whose queue is full.
    fn deliver(&mut self, id: ConnectionId, text: Utf8Bytes) {
        let Some(entry) = self.connections.get(&id) else {
            return;
        };
        match entry.outgoing.try_send(text) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                tracing::warn!(
                    connection = id,
                    "dropping a WebSocket connection that is not keeping up"
                );
                self.remove(id);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => self.remove(id),
        }
    }
}

fn encode(message: &ServerMessage) -> Option<Utf8Bytes> {
    match serde_json::to_string(message) {
        Ok(text) => Some(text.into()),
        Err(error) => {
            tracing::error!(%error, ?message, "encoding a server message");
            None
        }
    }
}
