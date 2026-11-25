//! The live-state task: the one owner of the Party state, keyed by Stage id.
//!
//! One task owns the live state and the [`hub::Hub`] and takes [`Command`]s
//! on a channel. WebSocket and HTTP handlers hold a [`LiveHandle`], send it
//! commands and await replies; none of them holds a lock on live state.
//!
//! Each Stage id has its current Party and, while one is open, the
//! connection that is the active Stage. v1 creates exactly one Stage id,
//! [`MAIN_STAGE`], and every connection is attached to it. After every
//! accepted change every connection is sent the whole Party plus a change
//! event; a refused command gets a refusal code back and changes nothing.

pub mod connection;
pub mod hub;
mod party;
mod store;

use std::collections::HashMap;

use openstar_protocol::{
    Actor, ChangeEvent, ChangeTopic, ClientMessage, PartyEvent, PartySnapshot, ServerMessage,
    StageId, UserMessage,
};
use tokio::sync::{mpsc, oneshot};

use crate::db::Database;
use hub::{Connection, ConnectionId, Hub};

/// The one Stage id in use in v1.
pub const MAIN_STAGE: &str = "main";

/// How many commands may wait for the task.
const COMMAND_CAPACITY: usize = 1024;

/// What a WebSocket connection was opened as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Any browser on `/ws`: a Phone, the Admin area, a Stage that moved.
    Browser,
    /// The Stage's WebSocket, `/ws/stage`: it becomes the active Stage,
    /// taking over from any earlier one.
    Stage,
}

/// What a handler asks of the live-state task.
enum Command {
    /// A browser connected: add it to the hub and tell it the live state.
    Connect {
        role: Role,
        /// The time of the request, in milliseconds since the Unix epoch.
        now_ms: i64,
        reply: oneshot::Sender<Connection>,
    },
    /// A browser sent a message (`Err` when it was not a [`ClientMessage`]).
    Received {
        id: ConnectionId,
        now_ms: i64,
        message: Result<ClientMessage, ()>,
    },
    /// A browser's socket closed.
    Disconnect { id: ConnectionId },
    /// Send a message to every connection (change notices, job updates).
    SendAll { message: ServerMessage },
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
        let state = LiveState::load(db).await?;
        let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
        tokio::spawn(state.run(receiver));
        Ok(Self { commands })
    }

    /// Registers a new connection; `None` once the task has stopped.
    pub async fn connect(&self, role: Role, now_ms: i64) -> Option<Connection> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::Connect {
                role,
                now_ms,
                reply,
            })
            .await
            .ok()?;
        answer.await.ok()
    }

    /// Hands a browser's message to the task; false once the task has stopped.
    pub async fn received(
        &self,
        id: ConnectionId,
        now_ms: i64,
        message: Result<ClientMessage, ()>,
    ) -> bool {
        self.commands
            .send(Command::Received {
                id,
                now_ms,
                message,
            })
            .await
            .is_ok()
    }

    pub async fn disconnect(&self, id: ConnectionId) {
        let _ = self.commands.send(Command::Disconnect { id }).await;
    }

    /// Sends a change notice for `topics` to every connection, after an HTTP
    /// handler changed the data they name.
    pub async fn changed(&self, topics: Vec<ChangeTopic>) {
        self.send_all(ServerMessage::Changed { topics }).await;
    }

    /// Sends `message` to every connected browser.
    pub async fn send_all(&self, message: ServerMessage) {
        let _ = self.commands.send(Command::SendAll { message }).await;
    }

    /// Stops the task and closes every WebSocket. Returns once it has stopped.
    pub async fn shutdown(&self) {
        let (done, stopped) = oneshot::channel();
        if self.commands.send(Command::Shutdown { done }).await.is_ok() {
            let _ = stopped.await;
        }
    }
}

/// The live state of one Stage id.
#[derive(Default)]
struct Stage {
    /// The current Party; `None` until the first Stage opens on a fresh server.
    party: Option<PartySnapshot>,
    /// The connection that is the active Stage, while one is open.
    connection: Option<ConnectionId>,
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
    /// The persisted state: v1's one Stage id with its current Party.
    async fn load(db: Database) -> anyhow::Result<Self> {
        let stage_id = StageId(MAIN_STAGE.to_owned());
        let party = store::load_party(&db, &stage_id).await?;
        let mut stages = HashMap::new();
        stages.insert(
            stage_id.clone(),
            Stage {
                party,
                connection: None,
            },
        );
        Ok(Self {
            db,
            current_stage: stage_id,
            stages,
            hub: Hub::default(),
        })
    }

    async fn run(mut self, mut commands: mpsc::Receiver<Command>) {
        while let Some(command) = commands.recv().await {
            match command {
                Command::Connect {
                    role,
                    now_ms,
                    reply,
                } => {
                    let connection = self.connect(role, now_ms).await;
                    let id = connection.id;
                    if reply.send(connection).is_err() {
                        self.disconnect(id);
                    }
                }
                Command::Received {
                    id,
                    now_ms,
                    message,
                } => self.received(id, now_ms, message).await,
                Command::Disconnect { id } => self.disconnect(id),
                Command::SendAll { message } => self.hub.send_all(&message),
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

    fn stage_mut(&mut self) -> &mut Stage {
        self.stages.entry(self.current_stage.clone()).or_default()
    }

    /// Adds a connection and tells it the live state first. A Stage
    /// connection becomes the active Stage: the one before it is told the
    /// Stage moved, and on a fresh server a Party starts by itself.
    async fn connect(&mut self, role: Role, now_ms: i64) -> Connection {
        let connection = self.hub.add();
        let id = connection.id;
        let mut started = None;
        if role == Role::Stage {
            if let Some(previous) = self.stage_mut().connection.replace(id) {
                self.hub.send_to(previous, &ServerMessage::StageMoved);
            }
            if self.stage().party.is_none() {
                started = self.start_party(now_ms).await;
            }
        }
        let live_state = ServerMessage::LiveState {
            stage_id: self.current_stage.clone(),
            party: self.stage().party.clone(),
            is_stage: self.stage().connection == Some(id),
        };
        self.hub.send_to(id, &live_state);
        if let Some(change) = started {
            self.party_changed(change);
        }
        connection
    }

    fn disconnect(&mut self, id: ConnectionId) {
        self.hub.remove(id);
        let stage = self.stage_mut();
        if stage.connection == Some(id) {
            stage.connection = None;
        }
    }

    async fn received(
        &mut self,
        id: ConnectionId,
        now_ms: i64,
        message: Result<ClientMessage, ()>,
    ) {
        match message {
            Ok(ClientMessage::Ping { nonce }) => {
                self.hub.send_to(id, &ServerMessage::Pong { nonce });
            }
            Ok(ClientMessage::NewParty) => {
                if self.stage().connection != Some(id) {
                    self.reject(id, UserMessage::NotTheStage);
                    return;
                }
                match self.start_party(now_ms).await {
                    Some(change) => self.party_changed(change),
                    None => self.reject(id, UserMessage::ServerError),
                }
            }
            Ok(ClientMessage::StoreCalibration {
                stage_output,
                results,
            }) => {
                let stored =
                    crate::mic_settings::store_calibration(self.db.clone(), stage_output, results);
                self.mic_settings_write(id, stored).await;
            }
            Ok(ClientMessage::SetMicThreshold {
                stage_output,
                local_mic_id,
                reference_dbfs,
            }) => {
                let stored = crate::mic_settings::set_threshold_by_hand(
                    self.db.clone(),
                    stage_output,
                    local_mic_id,
                    reference_dbfs,
                );
                self.mic_settings_write(id, stored).await;
            }
            Err(()) => self.reject(id, UserMessage::InvalidMessage),
        }
    }

    /// Starts a new Party on the current Stage, with a Join code other than
    /// the last Party's, and stores it. Returns the change, or `None` (and
    /// changes nothing) when it could not be stored. Always made by the Stage.
    async fn start_party(&mut self, now_ms: i64) -> Option<ChangeEvent> {
        let stored = async {
            let party =
                party::start_party(&self.current_stage, self.stage().party.as_ref(), now_ms)?;
            store::replace_party(&self.db, &party).await?;
            anyhow::Ok(party)
        };
        match stored.await {
            Ok(party) => {
                tracing::info!(party = %party.party_id.0, "a new Party started");
                let join_code = party.join_code.clone();
                self.stage_mut().party = Some(party);
                Some(ChangeEvent {
                    actor: Actor::Stage,
                    event: PartyEvent::PartyStarted { join_code },
                })
            }
            Err(error) => {
                tracing::error!(?error, "starting a Party");
                None
            }
        }
    }

    /// Runs a Mic settings write if `id` is the active Stage, then tells
    /// every connection Mic settings changed. Anyone else is refused and
    /// nothing is written.
    async fn mic_settings_write(
        &mut self,
        id: ConnectionId,
        write: impl Future<Output = anyhow::Result<()>>,
    ) {
        if self.stage().connection != Some(id) {
            self.reject(id, UserMessage::NotTheStage);
            return;
        }
        match write.await {
            Ok(()) => self.hub.send_all(&ServerMessage::Changed {
                topics: vec![ChangeTopic::MicSettings],
            }),
            Err(error) => {
                tracing::error!(?error, "storing Mic settings");
                self.reject(id, UserMessage::ServerError);
            }
        }
    }

    /// Tells every connection the whole Party after an accepted change, plus
    /// the change itself.
    fn party_changed(&mut self, change: ChangeEvent) {
        let Some(party) = self.stage().party.clone() else {
            return;
        };
        self.hub
            .send_all(&ServerMessage::PartyChanged { party, change });
    }

    /// Sends a Stage-only message to the active Stage alone, if one is open.
    /// A Stage that moved no longer receives these.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the first Stage-only messages come with #50's Pitch readings"
        )
    )]
    fn send_to_stage(&mut self, message: &ServerMessage) {
        if let Some(id) = self.stage().connection {
            self.hub.send_to(id, message);
        }
    }

    fn reject(&mut self, id: ConnectionId, reason: UserMessage) {
        self.hub.send_to(id, &ServerMessage::Rejected { reason });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn state() -> (LiveState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let opened = Database::open(dir.path()).await.unwrap();
        (LiveState::load(opened.database).await.unwrap(), dir)
    }

    /// Everything queued for `connection` so far.
    fn drain(connection: &mut Connection) -> Vec<ServerMessage> {
        let mut messages = Vec::new();
        while let Ok(text) = connection.outgoing.try_recv() {
            messages.push(serde_json::from_str(text.as_str()).unwrap());
        }
        messages
    }

    #[tokio::test]
    async fn stage_only_messages_go_to_the_active_stage_and_not_to_one_that_moved() {
        let (mut state, _dir) = state().await;
        let mut old = state.connect(Role::Stage, 1).await;
        let mut phone = state.connect(Role::Browser, 1).await;
        let mut new = state.connect(Role::Stage, 2).await;
        assert!(drain(&mut old).contains(&ServerMessage::StageMoved));
        drain(&mut phone);
        drain(&mut new);

        let stage_only = ServerMessage::Pong { nonce: 5 };
        state.send_to_stage(&stage_only);

        assert_eq!(drain(&mut new), vec![stage_only]);
        assert_eq!(drain(&mut old), vec![]);
        assert_eq!(drain(&mut phone), vec![]);
    }

    #[tokio::test]
    async fn stage_only_messages_go_nowhere_once_the_stage_has_closed() {
        let (mut state, _dir) = state().await;
        let stage = state.connect(Role::Stage, 1).await;
        let mut phone = state.connect(Role::Browser, 1).await;
        state.disconnect(stage.id);
        drain(&mut phone);
        state.send_to_stage(&ServerMessage::Pong { nonce: 5 });
        assert_eq!(drain(&mut phone), vec![]);
    }
}
