//! The live-state task: the one owner of everything live, keyed by Stage id.
//!
//! One task owns the live state and the [`hub::Hub`] and takes [`Command`]s
//! on a channel. WebSocket and HTTP handlers hold a [`LiveHandle`], send it
//! commands and await replies; none of them holds a lock on live state.
//!
//! Until #48 the live state is a placeholder text per Stage that any browser
//! can change; #48 replaces it with the Party, Party members, Line-up, Queue
//! and Stage.

pub mod connection;
pub mod hub;
mod store;

use std::collections::HashMap;

use openstar_protocol::{
    ChangeTopic, ClientMessage, PLACEHOLDER_MAX_LENGTH, ServerMessage, StageId, StagePlaceholder,
    UserMessage,
};
use tokio::sync::{mpsc, oneshot};

use crate::db::Database;
use hub::{Connection, ConnectionId, Hub};

/// The one Stage id in use in v1.
pub const MAIN_STAGE: &str = "main";

/// How many commands may wait for the task.
const COMMAND_CAPACITY: usize = 1024;

/// What a handler asks of the live-state task.
enum Command {
    /// A browser connected: add it to the hub and tell it the live state.
    Connect { reply: oneshot::Sender<Connection> },
    /// A browser sent a message (`Err` when it was not a [`ClientMessage`]).
    Received {
        id: ConnectionId,
        message: Result<ClientMessage, ()>,
    },
    /// A browser's socket closed.
    Disconnect { id: ConnectionId },
    /// `GET /api/placeholder`.
    Placeholder {
        reply: oneshot::Sender<StagePlaceholder>,
    },
    /// HTTP data changed: tell every connection which topics to refetch.
    Changed { topics: Vec<ChangeTopic> },
    /// Stop: drop every connection (their sockets close) and end the task.
    Shutdown { done: oneshot::Sender<()> },
}

/// A handle to the live-state task. Cheap to clone.
#[derive(Clone)]
pub struct LiveHandle {
    commands: mpsc::Sender<Command>,
}

impl LiveHandle {
    /// Reloads the persisted live state from SQLite, then starts the task.
    pub async fn start(db: Database) -> anyhow::Result<Self> {
        let stage_id = StageId(MAIN_STAGE.to_owned());
        let placeholder = store::load_placeholder(&db, &stage_id).await?;
        let mut stages = HashMap::new();
        stages.insert(stage_id.clone(), Stage { placeholder });
        let state = LiveState {
            db,
            current_stage: stage_id,
            stages,
            hub: Hub::default(),
        };
        let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
        tokio::spawn(state.run(receiver));
        Ok(Self { commands })
    }

    /// Registers a new connection; `None` once the task has stopped.
    pub async fn connect(&self) -> Option<Connection> {
        let (reply, answer) = oneshot::channel();
        self.commands.send(Command::Connect { reply }).await.ok()?;
        answer.await.ok()
    }

    /// Hands a browser's message to the task; false once the task has stopped.
    pub async fn received(&self, id: ConnectionId, message: Result<ClientMessage, ()>) -> bool {
        self.commands
            .send(Command::Received { id, message })
            .await
            .is_ok()
    }

    pub async fn disconnect(&self, id: ConnectionId) {
        let _ = self.commands.send(Command::Disconnect { id }).await;
    }

    /// The placeholder of the Stage in use; `None` once the task has stopped.
    pub async fn placeholder(&self) -> Option<StagePlaceholder> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::Placeholder { reply })
            .await
            .ok()?;
        answer.await.ok()
    }

    /// Sends a change notice for `topics` to every connection, after an HTTP
    /// handler changed the data they name.
    pub async fn changed(&self, topics: Vec<ChangeTopic>) {
        let _ = self.commands.send(Command::Changed { topics }).await;
    }

    /// Stops the task and closes every WebSocket. Returns once it has stopped.
    pub async fn shutdown(&self) {
        let (done, stopped) = oneshot::channel();
        if self.commands.send(Command::Shutdown { done }).await.is_ok() {
            let _ = stopped.await;
        }
    }
}

struct Stage {
    placeholder: String,
}

/// Owned by the task alone.
struct LiveState {
    db: Database,
    /// The Stage every connection is attached to: the one in use.
    current_stage: StageId,
    stages: HashMap<StageId, Stage>,
    hub: Hub,
}

impl LiveState {
    async fn run(mut self, mut commands: mpsc::Receiver<Command>) {
        while let Some(command) = commands.recv().await {
            match command {
                Command::Connect { reply } => {
                    let connection = self.hub.add();
                    let id = connection.id;
                    if reply.send(connection).is_ok() {
                        let snapshot = self.snapshot();
                        self.hub.send_to(id, &snapshot);
                    } else {
                        self.hub.remove(id);
                    }
                }
                Command::Received { id, message } => self.received(id, message).await,
                Command::Disconnect { id } => self.hub.remove(id),
                Command::Placeholder { reply } => {
                    let _ = reply.send(StagePlaceholder {
                        stage_id: self.current_stage.clone(),
                        placeholder: self.stage().placeholder.clone(),
                    });
                }
                Command::Changed { topics } => {
                    self.hub.send_all(&ServerMessage::Changed { topics });
                }
                Command::Shutdown { done } => {
                    drop(self);
                    let _ = done.send(());
                    return;
                }
            }
        }
    }

    fn stage(&self) -> &Stage {
        &self.stages[&self.current_stage]
    }

    fn snapshot(&self) -> ServerMessage {
        ServerMessage::LiveState {
            stage_id: self.current_stage.clone(),
            placeholder: self.stage().placeholder.clone(),
        }
    }

    async fn received(&mut self, id: ConnectionId, message: Result<ClientMessage, ()>) {
        match message {
            Ok(ClientMessage::Ping { nonce }) => {
                self.hub.send_to(id, &ServerMessage::Pong { nonce });
            }
            Ok(ClientMessage::SetPlaceholder { text }) => self.set_placeholder(id, text).await,
            Err(()) => self.reject(id, UserMessage::InvalidMessage),
        }
    }

    async fn set_placeholder(&mut self, id: ConnectionId, text: String) {
        if text.chars().count() > PLACEHOLDER_MAX_LENGTH as usize {
            self.reject(
                id,
                UserMessage::PlaceholderTooLong {
                    max_length: PLACEHOLDER_MAX_LENGTH,
                },
            );
            return;
        }
        let stage_id = self.current_stage.clone();
        if let Err(error) = store::save_placeholder(&self.db, &stage_id, text.clone()).await {
            tracing::error!(?error, "saving the placeholder");
            self.reject(id, UserMessage::ServerError);
            return;
        }
        if let Some(stage) = self.stages.get_mut(&stage_id) {
            stage.placeholder.clone_from(&text);
        }
        self.hub.send_all(&ServerMessage::PlaceholderChanged {
            stage_id,
            placeholder: text,
        });
        self.hub.send_all(&ServerMessage::Changed {
            topics: vec![ChangeTopic::Placeholder],
        });
    }

    fn reject(&mut self, id: ConnectionId, reason: UserMessage) {
        self.hub.send_to(id, &ServerMessage::Rejected { reason });
    }
}
