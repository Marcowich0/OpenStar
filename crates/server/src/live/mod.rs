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
//!
//! The task is also the Pitch reading relay: a browser's readings and clock
//! pings go to the active Stage alone, tagged with the [`MicId`] they came
//! from, and are dropped while there is no Stage; the Stage's pongs go back
//! to the Mic that pinged. The relay never changes a reading, never scores
//! and never touches SQLite.

mod bridges;
pub mod connection;
pub mod hub;
mod line_up;
mod party;
mod queue;
mod songs;
mod store;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use openstar_protocol::bridge::bridge_local_mic_id;
use openstar_protocol::library::SongId;
use openstar_protocol::mics::{LocalMicSource, MicKey};
use openstar_protocol::profile::{Difficulty, NewProfile, Profile, ProfileEdit, ProfileId};
use openstar_protocol::volume::VolumeStep;
use openstar_protocol::{
    Actor, ChangeEvent, ChangeTopic, ClientMessage, Identity, JoinAs, JoinCode, JoinedPhone,
    LineUp, LineUpEdit, MemberEdit, MicId, PartyEvent, PartyMemberId, PartySnapshot, PhoneId,
    PlayingSong, QueueMove, Request, RequestChange, RequestId, RequestKind, SeatWho, ServerMessage,
    SongControl, SongEnd, SongResults, StageId, UserMessage,
};
use tokio::sync::{mpsc, oneshot};

use crate::db::Database;
use crate::profiles::{self, Refused};
use crate::stage_outputs::{self, StageOutput};
use hub::{Connection, ConnectionId, Hub};
use party::Joined;
use songs::{LibraryIndex, SongLookup, Songs};

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
    /// A Mic bridge's WebSocket, `/ws/bridge`: it may ask to join.
    Bridge,
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
    /// `POST /api/profiles`: create a Profile, unless the current Party
    /// refuses it (a Guest has the name, or the Party is full).
    CreateProfile {
        new: NewProfile,
        now_ms: i64,
        reply: oneshot::Sender<anyhow::Result<Result<Profile, Refused>>>,
    },
    /// `PATCH /api/profiles/{id}`: edit a Profile outside the Party (any
    /// colour, only the favourite changes), unless a Guest has the new name.
    EditProfile {
        id: ProfileId,
        edit: ProfileEdit,
        reply: oneshot::Sender<anyhow::Result<Result<Profile, Refused>>>,
    },
    /// Songs left the Library (deleted in the Admin area, or gone at a
    /// Rescan), each with the title it had there: their queued Requests are
    /// dropped. The playing Request is not: a Song that plays cannot be
    /// deleted, and one gone at a Rescan plays on until it ends or is
    /// skipped.
    SongsLeft { songs: Vec<(SongId, String)> },
    /// Whether Song `song_id` plays on the Stage now (a Song delete is
    /// refused then).
    #[cfg_attr(not(test), expect(dead_code))]
    SongPlaying {
        song_id: SongId,
        reply: oneshot::Sender<bool>,
    },
    /// The Admin area deletes a Profile: a Party member leaves the Party
    /// first, in the same transaction. Refused while it sings in the
    /// playing Song.
    DeleteProfile {
        id: ProfileId,
        reply: oneshot::Sender<anyhow::Result<Result<(), Refused>>>,
    },
    /// `GET /api/mic-bridges`: approved bridges and those waiting.
    MicBridges {
        reply: oneshot::Sender<openstar_protocol::bridge::MicBridges>,
    },
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

    /// Creates a Profile (see [`Command::CreateProfile`]) and tells every
    /// connection the Profiles changed.
    pub async fn create_profile(
        &self,
        new: NewProfile,
        now_ms: i64,
    ) -> anyhow::Result<Result<Profile, Refused>> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::CreateProfile { new, now_ms, reply })
            .await
            .map_err(|_| anyhow::anyhow!("the live-state task has stopped"))?;
        answer.await?
    }

    /// Edits a Profile (see [`Command::EditProfile`]) and tells every
    /// connection the Profiles changed.
    pub async fn edit_profile(
        &self,
        id: ProfileId,
        edit: ProfileEdit,
    ) -> anyhow::Result<Result<Profile, Refused>> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::EditProfile { id, edit, reply })
            .await
            .map_err(|_| anyhow::anyhow!("the live-state task has stopped"))?;
        answer.await?
    }

    /// Tells the Party that these Songs left the Library, each with the
    /// title it had there (see [`Command::SongsLeft`]): their queued
    /// Requests are dropped, each with a change event naming the Song.
    pub async fn songs_left(&self, songs: Vec<(SongId, String)>) {
        if !songs.is_empty() {
            let _ = self.commands.send(Command::SongsLeft { songs }).await;
        }
    }

    /// Whether Song `song_id` plays on the Stage now; false once the task
    /// has stopped. The seam #190's Song delete asks.
    #[cfg_attr(not(test), expect(dead_code))]
    pub async fn song_playing(&self, song_id: SongId) -> bool {
        let (reply, answer) = oneshot::channel();
        if self
            .commands
            .send(Command::SongPlaying { song_id, reply })
            .await
            .is_err()
        {
            return false;
        }
        answer.await.unwrap_or(false)
    }

    /// Deletes Profile `id` and its Score records (see
    /// [`Command::DeleteProfile`]). `Refused::NotFound` when there is no
    /// such Profile, `Refused::Party(ProfileSinging)` while it sings.
    pub async fn delete_profile(&self, id: ProfileId) -> anyhow::Result<Result<(), Refused>> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::DeleteProfile { id, reply })
            .await
            .map_err(|_| anyhow::anyhow!("the live-state task has stopped"))?;
        answer.await?
    }

    /// Approved Mic bridges (open or closed) and bridges waiting for
    /// approval; `None` once the task has stopped.
    pub async fn mic_bridges(&self) -> Option<openstar_protocol::bridge::MicBridges> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::MicBridges { reply })
            .await
            .ok()?;
        answer.await.ok()
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
    /// The Local mic each member of the current Party last sang on in it.
    last_local_mics: HashMap<PartyMemberId, String>,
    /// The connection that is the active Stage, while one is open.
    connection: Option<ConnectionId>,
    /// The Stage output the active Stage last reported, with its OpenStar
    /// volume. Gone when that Stage closes or another becomes the Stage.
    output: Option<(StageOutput, u8)>,
}

/// Owned by the task alone.
struct LiveState {
    db: Database,
    /// The Stage every connection is attached to: the one in use.
    current_stage: StageId,
    stages: HashMap<StageId, Stage>,
    hub: Hub,
    /// Connections that have sent a Pitch reading or a clock ping: Mics, so
    /// their close is reported to the Stage.
    mics: HashSet<ConnectionId>,
    /// The Phone id each connection presented. Kept for the connection's
    /// life, whether or not that Phone is in the Party, so a Phone told it
    /// left can join again on the same connection.
    phones: HashMap<ConnectionId, PhoneId>,
    /// Whether a Song is in the Library and can be queued.
    songs: Arc<dyn Songs>,
    /// The Local mics that are switched on and present, in Mics-screen
    /// order: what the Line-up's Mic prefill may choose. Empty until the
    /// Stage and the Mic bridges report Local mics (#51's tickets fill it).
    local_mics: Vec<String>,
    /// Phones that reported their mic could not open. Kept while the
    /// server runs; a Phone reports again after a restart.
    blocked_phones: HashSet<PhoneId>,
    /// Mic bridges: approved (open or closed) and waiting for approval.
    bridges: bridges::Bridges,
}

impl LiveState {
    /// The persisted state: v1's one Stage id with its current Party.
    async fn load(db: Database) -> anyhow::Result<Self> {
        Self::load_with(db, Arc::new(LibraryIndex)).await
    }

    /// [`Self::load`] with the Library lookup handed in.
    async fn load_with(db: Database, songs: Arc<dyn Songs>) -> anyhow::Result<Self> {
        let stage_id = StageId(MAIN_STAGE.to_owned());
        let mut party = store::load_party(&db, &stage_id).await?;
        let last_local_mics = match &party {
            Some(party) => store::load_last_local_mics(&db, &party.party_id).await?,
            None => HashMap::new(),
        };
        if let Some(party) = party.as_mut() {
            refresh_computed(party, &HashSet::new());
        }
        let bridges = bridges::Bridges::new(crate::mic_bridges::load(&db).await?);
        let mut stages = HashMap::new();
        stages.insert(
            stage_id.clone(),
            Stage {
                party,
                last_local_mics,
                connection: None,
                output: None,
            },
        );
        Ok(Self {
            db,
            current_stage: stage_id,
            stages,
            hub: Hub::default(),
            mics: HashSet::new(),
            phones: HashMap::new(),
            songs,
            local_mics: Vec::new(),
            blocked_phones: HashSet::new(),
            bridges,
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
                Command::CreateProfile { new, now_ms, reply } => {
                    let _ = reply.send(self.create_profile(new, now_ms).await);
                }
                Command::EditProfile { id, edit, reply } => {
                    let _ = reply.send(self.edit_profile(id, edit).await);
                }
                Command::SongsLeft { songs } => self.songs_left(songs).await,
                Command::SongPlaying { song_id, reply } => {
                    let _ = reply.send(self.song_playing(song_id));
                }
                Command::DeleteProfile { id, reply } => {
                    let _ = reply.send(self.delete_profile(id).await);
                }
                Command::MicBridges { reply } => {
                    let _ = reply.send(self.bridges.listing());
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
        if role == Role::Bridge {
            self.bridges.sockets.insert(id);
        }
        if role == Role::Stage {
            if let Some(previous) = self.stage_mut().connection.replace(id) {
                self.hub.send_to(previous, &ServerMessage::StageMoved);
            }
            // The new Stage reports its own output.
            self.stage_mut().output = None;
            if self.stage().party.is_none() {
                started = self.start_party(now_ms).await;
            }
            // A Stage that moved takes its Mics screen with it.
            self.tell_mics_screen();
        }
        let live_state = ServerMessage::LiveState {
            stage_id: self.current_stage.clone(),
            party: self.stage().party.clone(),
            is_stage: self.stage().connection == Some(id),
        };
        self.hub.send_to(id, &live_state);
        if let Some((_, volume)) = self.stage().output {
            self.hub.send_to(
                id,
                &ServerMessage::Volume {
                    volume,
                    stepped: false,
                },
            );
        }
        if let Some(change) = started {
            self.party_changed(change);
        }
        connection
    }

    fn disconnect(&mut self, id: ConnectionId) {
        self.hub.remove(id);
        self.phones.remove(&id);
        let stage = self.stage_mut();
        if stage.connection == Some(id) {
            stage.connection = None;
            stage.output = None;
            self.tell_mics_screen();
        }
        if self.mics.remove(&id) {
            self.send_to_stage(&ServerMessage::MicClosed { mic: mic_id(id) });
        }
        self.bridge_closed(id);
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
                let left = self.joined_connections();
                match self.start_party(now_ms).await {
                    Some(change) => {
                        for connection in left {
                            self.hub.send_to(connection, &ServerMessage::LeftParty);
                        }
                        self.party_changed(change);
                    }
                    None => self.reject(id, UserMessage::ServerError),
                }
            }
            Ok(ClientMessage::PitchReading { reading }) => {
                self.mics.insert(id);
                self.send_to_stage(&ServerMessage::PitchReading {
                    mic: mic_id(id),
                    reading,
                });
            }
            Ok(ClientMessage::ClockPing { t0 }) => {
                self.mics.insert(id);
                self.send_to_stage(&ServerMessage::ClockPing {
                    mic: mic_id(id),
                    t0,
                });
            }
            Ok(ClientMessage::ClockPong { mic, t0, ts, epoch }) => {
                if self.stage().connection != Some(id) {
                    self.reject(id, UserMessage::NotTheStage);
                    return;
                }
                let MicId::Phone { connection } = mic;
                // A pong for a Mic that has gone is dropped.
                if self.mics.contains(&connection) {
                    self.hub
                        .send_to(connection, &ServerMessage::ClockPong { t0, ts, epoch });
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
            Ok(ClientMessage::SetLocalMicSwitchedOn {
                local_mic_id,
                source,
                switched_on,
            }) => {
                if !local_mic_id_fits(&local_mic_id, &source) {
                    self.reject(id, UserMessage::InvalidMessage);
                    return;
                }
                let stored =
                    crate::local_mics::switch(self.db.clone(), local_mic_id, source, switched_on);
                self.mic_settings_write(id, stored).await;
            }
            Ok(ClientMessage::SetLocalMicName {
                local_mic_id,
                source,
                name,
            }) => {
                if !local_mic_id_fits(&local_mic_id, &source) {
                    self.reject(id, UserMessage::InvalidMessage);
                    return;
                }
                let stored = crate::local_mics::rename(self.db.clone(), local_mic_id, source, name);
                self.mic_settings_write(id, stored).await;
            }
            Ok(ClientMessage::RelinkLocalMic {
                local_mic_id,
                new_local_mic_id,
                source,
            }) => {
                if !local_mic_id_fits(&new_local_mic_id, &source) {
                    self.reject(id, UserMessage::InvalidMessage);
                    return;
                }
                let relinked = crate::local_mics::relink(
                    self.db.clone(),
                    local_mic_id,
                    new_local_mic_id,
                    source,
                );
                self.refusable_mic_settings_write(id, relinked).await;
            }
            Ok(ClientMessage::ReportStageOutput {
                stage_browser,
                stage_output,
            }) => {
                let output = StageOutput {
                    stage_browser,
                    stage_output,
                };
                let result = self.report_stage_output(id, output).await;
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::StepVolume { step }) => {
                let result = self.step_volume(id, step).await;
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::Hello { phone_id }) => {
                if !phone_id.is_valid() {
                    self.reject(id, UserMessage::InvalidMessage);
                    return;
                }
                self.phones.insert(id, phone_id);
                self.send_phone_status(id);
            }
            Ok(ClientMessage::CheckJoinCode { join_code }) => {
                if self.is_current_code(&join_code) {
                    self.hub
                        .send_to(id, &ServerMessage::JoinCodeValid { join_code });
                } else {
                    self.reject(id, UserMessage::JoinCodeWrong);
                }
            }
            Ok(ClientMessage::Join {
                phone_id,
                join_code,
                join_as,
            }) => {
                if !phone_id.is_valid() {
                    self.reject(id, UserMessage::InvalidMessage);
                    return;
                }
                self.phones.insert(id, phone_id.clone());
                let joined = self.join(phone_id, &join_code, join_as, now_ms).await;
                self.refuse_on_error(id, joined);
            }
            Ok(ClientMessage::SwitchIdentity { join_as }) => {
                let switched = self.switch_identity(id, join_as, now_ms).await;
                self.refuse_on_error(id, switched);
            }
            Ok(ClientMessage::EditMember { member_id, edit }) => {
                let edited = self.edit_member(id, member_id, edit).await;
                self.refuse_on_error(id, edited);
            }
            Ok(ClientMessage::AddRequest {
                song_id,
                requested_players,
            }) => {
                let added = self.add_request(id, song_id, requested_players).await;
                self.refuse_on_error(id, added);
            }
            Ok(ClientMessage::MoveRequest { request_id, to }) => {
                let moved = self.move_request(id, request_id, to).await;
                self.refuse_on_error(id, moved);
            }
            Ok(ClientMessage::SetRequestedPlayers {
                request_id,
                requested_players,
            }) => {
                let changed = self
                    .set_requested_players(id, request_id, requested_players)
                    .await;
                self.refuse_on_error(id, changed);
            }
            Ok(ClientMessage::RemoveRequest { request_id }) => {
                let removed = self.remove_request(id, request_id).await;
                self.refuse_on_error(id, removed);
            }
            Ok(ClientMessage::ReportMicBlocked { blocked }) => {
                let reported = self.report_mic_blocked(id, blocked).await;
                self.refuse_on_error(id, reported);
            }
            Ok(ClientMessage::LeaveParty) => {
                let left = self.leave_party(id).await;
                self.refuse_on_error(id, left);
            }
            Ok(ClientMessage::RemoveMember { member_id }) => {
                let removed = self.remove_member(id, member_id).await;
                self.refuse_on_error(id, removed);
            }
            Ok(ClientMessage::EditLineUp { request_id, edit }) => {
                let edited = self.edit_line_up(id, request_id, edit, now_ms).await;
                self.refuse_on_error(id, edited);
            }
            Ok(ClientMessage::SetMyDifficulty { difficulty }) => {
                let set = self.set_my_difficulty(id, difficulty).await;
                self.refuse_on_error(id, set);
            }
            Ok(ClientMessage::ControlSong {
                request_id,
                control,
            }) => {
                let controlled = self.control_song(id, request_id, control).await;
                self.refuse_on_error(id, controlled);
            }
            Ok(ClientMessage::ReachedResults { request_id, ended }) => {
                let shown = self.reached_results(id, request_id, ended).await;
                self.refuse_on_error(id, shown);
            }
            Ok(ClientMessage::CloseResults) => {
                let closed = self.close_results(id).await;
                self.refuse_on_error(id, closed);
            }
            Ok(ClientMessage::BridgeHello {
                build,
                host_name,
                token,
                interfaces,
            }) => {
                self.bridge_hello(id, build, host_name, token, interfaces)
                    .await;
            }
            Ok(ClientMessage::SetMicsScreenOpen { open }) => {
                self.set_mics_screen_open(id, open);
            }
            Ok(ClientMessage::BridgeLevels { levels }) => {
                self.bridge_levels(id, levels);
            }
            Ok(ClientMessage::ApproveBridge { request_id }) => {
                self.approve_bridge(id, request_id, now_ms).await;
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
                let stage = self.stage_mut();
                stage.party = Some(party);
                stage.last_local_mics.clear();
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

    /// Runs a Mic settings (or Local mic) write if `id` is the active Stage, then tells
    /// every connection Mic settings changed. Anyone else is refused and
    /// nothing is written.
    async fn mic_settings_write(
        &mut self,
        id: ConnectionId,
        write: impl Future<Output = anyhow::Result<()>>,
    ) {
        self.refusable_mic_settings_write(id, async { write.await.map(Ok) })
            .await;
    }

    /// [`Self::mic_settings_write`] for a write that may refuse with a code.
    async fn refusable_mic_settings_write(
        &mut self,
        id: ConnectionId,
        write: impl Future<Output = anyhow::Result<Result<(), UserMessage>>>,
    ) {
        if self.stage().connection != Some(id) {
            self.reject(id, UserMessage::NotTheStage);
            return;
        }
        match write.await {
            Ok(Ok(())) => {
                self.hub.send_all(&ServerMessage::Changed {
                    topics: vec![ChangeTopic::MicSettings],
                });
                // Open bridges show each channel's switch and name.
                self.send_bridge_channels(None).await;
            }
            Ok(Err(refused)) => self.reject(id, refused),
            Err(error) => {
                tracing::error!(?error, "storing Mic settings");
                self.reject(id, UserMessage::ServerError);
            }
        }
    }

    /// The active Stage reports its Stage output: the volume becomes that
    /// output's stored one (80 when none is), and every connection hears it.
    async fn report_stage_output(
        &mut self,
        id: ConnectionId,
        output: StageOutput,
    ) -> Result<(), UserMessage> {
        if self.stage().connection != Some(id) {
            return Err(UserMessage::NotTheStage);
        }
        let volume = stage_outputs::volume(&self.db, &output)
            .await
            .map_err(|error| server_error(&error, "reading the OpenStar volume"))?;
        self.stage_mut().output = Some((output, volume));
        self.hub.send_all(&ServerMessage::Volume {
            volume,
            stepped: false,
        });
        Ok(())
    }

    /// One step of the OpenStar volume from the Stage or a joined Phone,
    /// stored at the Stage's current output; every connection hears it.
    async fn step_volume(&mut self, id: ConnectionId, step: VolumeStep) -> Result<(), UserMessage> {
        self.remote_actor(id)?;
        let Some((output, volume)) = self.stage().output.clone() else {
            return Err(UserMessage::NoStage);
        };
        let volume = step.apply(volume);
        stage_outputs::set_volume(&self.db, &output, volume)
            .await
            .map_err(|error| server_error(&error, "storing the OpenStar volume"))?;
        self.stage_mut().output = Some((output, volume));
        self.hub.send_all(&ServerMessage::Volume {
            volume,
            stepped: true,
        });
        Ok(())
    }

    /// Whether `code` is the current Party's Join code. Wrong codes are not
    /// counted or delayed.
    fn is_current_code(&self, code: &JoinCode) -> bool {
        self.stage()
            .party
            .as_ref()
            .is_some_and(|party| &party.join_code == code)
    }

    /// The joined Phone that connection `id` presented, if it is in the Party.
    fn joined_phone(&self, id: ConnectionId) -> Option<&JoinedPhone> {
        let phone_id = self.phones.get(&id)?;
        let party = self.stage().party.as_ref()?;
        party
            .phones
            .iter()
            .find(|phone| &phone.phone_id == phone_id)
    }

    /// Every connection whose Phone is in the current Party.
    fn joined_connections(&self) -> Vec<ConnectionId> {
        self.phones
            .keys()
            .copied()
            .filter(|&id| self.joined_phone(id).is_some())
            .collect()
    }

    /// Tells connection `id` which Party member its Phone uses, if any.
    fn send_phone_status(&mut self, id: ConnectionId) {
        let member_id = self.joined_phone(id).map(|phone| phone.member_id);
        self.hub
            .send_to(id, &ServerMessage::PhoneStatus { member_id });
    }

    /// Who is making a Remote command from connection `id`: the active
    /// Stage, or the Party member of a joined Phone. Any other connection is
    /// not in the Party and is refused with [`UserMessage::NotInParty`].
    fn remote_actor(&self, id: ConnectionId) -> Result<Actor, UserMessage> {
        if self.stage().connection == Some(id) {
            return Ok(Actor::Stage);
        }
        self.joined_phone(id)
            .map(|phone| Actor::Member {
                member_id: phone.member_id,
            })
            .ok_or(UserMessage::NotInParty)
    }

    /// Joins `phone_id` to the current Party with its Join code (see
    /// [`Self::enter`]).
    async fn join(
        &mut self,
        phone_id: PhoneId,
        join_code: &JoinCode,
        join_as: JoinAs,
        now_ms: i64,
    ) -> Result<(), UserMessage> {
        if !self.is_current_code(join_code) {
            return Err(UserMessage::JoinCodeWrong);
        }
        self.enter(phone_id, join_as, now_ms).await
    }

    /// Switches the identity of connection `id`'s joined Phone, with no
    /// Join code. The member it used stays in the Party with its colour.
    async fn switch_identity(
        &mut self,
        id: ConnectionId,
        join_as: JoinAs,
        now_ms: i64,
    ) -> Result<(), UserMessage> {
        let phone_id = self
            .joined_phone(id)
            .ok_or(UserMessage::NotInParty)?
            .phone_id
            .clone();
        self.enter(phone_id, join_as, now_ms).await
    }

    /// Makes `phone_id` use `join_as` in the current Party: an existing
    /// Profile, a new Guest, or a new Profile created in the same step (and
    /// only if it can enter). Stores it and tells everyone; every connection
    /// of that Phone gets its [`ServerMessage::PhoneStatus`]. A refusal
    /// changes and creates nothing.
    async fn enter(
        &mut self,
        phone_id: PhoneId,
        join_as: JoinAs,
        now_ms: i64,
    ) -> Result<(), UserMessage> {
        let mut party = self.party()?;
        let (party, joined, name, created) = match join_as {
            JoinAs::Profile { profile_id } => {
                let profile = profiles::get(&self.db, profile_id)
                    .await
                    .map_err(|error| server_error(&error, "reading a Profile to join"))?
                    .ok_or(UserMessage::ProfileNotFound)?;
                let joined = party::join_phone(
                    &mut party,
                    phone_id.clone(),
                    profile_id,
                    profile.favourite_colour,
                )?;
                self.save_join(&party, joined, &phone_id).await?;
                (party, joined, profile.name, false)
            }
            JoinAs::Guest(guest) => {
                let name = profiles::check_name(&guest.name)?;
                self.refuse_profile_name(&name).await?;
                let joined = party::join_guest(
                    &mut party,
                    phone_id.clone(),
                    &name,
                    guest.colour,
                    guest.avatar,
                )?;
                self.save_join(&party, joined, &phone_id).await?;
                (party, joined, name.display, false)
            }
            JoinAs::NewProfile(new) => {
                let (party, joined, profile) = self
                    .enter_new_profile(party, phone_id.clone(), new, now_ms)
                    .await?;
                (party, joined, profile.name, true)
            }
        };
        let member = party
            .members
            .iter()
            .find(|member| member.member_id == joined.member_id)
            .cloned()
            .ok_or(UserMessage::ServerError)?;
        self.stage_mut().party = Some(party);
        if created {
            self.hub.send_all(&ServerMessage::Changed {
                topics: vec![ChangeTopic::Profiles],
            });
        }
        let joining: Vec<ConnectionId> = self
            .phones
            .iter()
            .filter(|(_, phone)| **phone == phone_id)
            .map(|(&id, _)| id)
            .collect();
        for id in joining {
            self.send_phone_status(id);
        }
        let event = if joined.new_member {
            PartyEvent::MemberJoined {
                member_id: member.member_id,
                name,
                colour: member.colour,
            }
        } else {
            PartyEvent::PhoneJoined {
                member_id: member.member_id,
                name,
            }
        };
        self.party_changed(ChangeEvent {
            actor: Actor::Member {
                member_id: member.member_id,
            },
            event,
        });
        Ok(())
    }

    /// Stores a join already applied to `party`.
    async fn save_join(
        &self,
        party: &PartySnapshot,
        joined: Joined,
        phone_id: &PhoneId,
    ) -> Result<(), UserMessage> {
        let new_member = party
            .members
            .iter()
            .find(|member| joined.new_member && member.member_id == joined.member_id);
        let phone = JoinedPhone {
            phone_id: phone_id.clone(),
            member_id: joined.member_id,
        };
        store::save_join(&self.db, &party.party_id, new_member, &phone)
            .await
            .map_err(|error| server_error(&error, "storing a join"))
    }

    /// Creates a Profile and joins `phone_id` to `party` as it, in one
    /// transaction: the Profile exists only if it entered the Party.
    async fn enter_new_profile(
        &self,
        mut party: PartySnapshot,
        phone_id: PhoneId,
        new: NewProfile,
        now_ms: i64,
    ) -> Result<(PartySnapshot, Joined, Profile), UserMessage> {
        let name = profiles::check_name(&new.name)?;
        refuse_new_profile(&party, &name)?;
        self.db
            .call(move |conn| {
                let tx = conn.transaction()?;
                let profile = match profiles::create_in(&tx, &name, &new, now_ms)? {
                    Ok(profile) => profile,
                    Err(refused) => return Ok(Err(refusal(refused))),
                };
                let joined = match party::join_phone(
                    &mut party,
                    phone_id.clone(),
                    profile.id,
                    profile.favourite_colour,
                ) {
                    Ok(joined) => joined,
                    Err(refused) => return Ok(Err(refused)),
                };
                let new_member = party
                    .members
                    .iter()
                    .find(|member| member.member_id == joined.member_id);
                let phone = JoinedPhone {
                    phone_id,
                    member_id: joined.member_id,
                };
                store::save_join_in(&tx, &party.party_id, new_member, &phone)?;
                tx.commit()?;
                Ok(Ok((party, joined, profile)))
            })
            .await
            .map_err(|error| server_error(&error, "creating a Profile to join"))?
    }

    /// Refuses `name` for a Guest when a Profile has it, naming that
    /// Profile so the Phone can ask "Are you <name>?".
    async fn refuse_profile_name(&self, name: &profiles::CheckedName) -> Result<(), UserMessage> {
        let holder = profiles::named(&self.db, name.key.clone())
            .await
            .map_err(|error| server_error(&error, "looking up a Profile name"))?;
        match holder {
            Some(profile_id) => Err(UserMessage::ProfileNameTaken { profile_id }),
            None => Ok(()),
        }
    }

    /// `POST /api/profiles`, refused by the current Party when a Guest has
    /// the name or twelve colours are held.
    async fn create_profile(
        &mut self,
        new: NewProfile,
        now_ms: i64,
    ) -> anyhow::Result<Result<Profile, Refused>> {
        let name = match profiles::check_name(&new.name) {
            Ok(name) => name,
            Err(message) => return Ok(Err(Refused::Name(message))),
        };
        if let Some(party) = &self.stage().party
            && let Err(message) = refuse_new_profile(party, &name)
        {
            return Ok(Err(Refused::Party(message)));
        }
        let created = profiles::create(&self.db, new, now_ms).await?;
        self.profiles_changed(&created);
        Ok(created)
    }

    /// `PATCH /api/profiles/{id}`: the edit outside a Party. Only a rename
    /// to a current Guest's name is refused by the Party.
    async fn edit_profile(
        &mut self,
        id: ProfileId,
        edit: ProfileEdit,
    ) -> anyhow::Result<Result<Profile, Refused>> {
        if let Some(raw) = &edit.name
            && let Some(party) = &self.stage().party
            && let Some(member_id) = party::guest_named(party, &profiles::name_key(raw), None)
        {
            return Ok(Err(Refused::Party(UserMessage::NameTakenTonight {
                member_id,
            })));
        }
        let edited = profiles::edit(&self.db, id, edit).await?;
        self.profiles_changed(&edited);
        Ok(edited)
    }

    /// Tells every connection the Profiles changed, after an accepted
    /// create or edit.
    fn profiles_changed(&mut self, result: &Result<Profile, Refused>) {
        if result.is_ok() {
            self.hub.send_all(&ServerMessage::Changed {
                topics: vec![ChangeTopic::Profiles],
            });
        }
    }

    /// Deletes Profile `id` (the Admin area): a Party member leaves the
    /// Party (see [`party::delete_profile`]) in the same transaction as the
    /// Profile and its Score records go. Every Phone that used it is told
    /// it left the Party, and everyone hears of it, the Stage included.
    async fn delete_profile(&mut self, id: ProfileId) -> anyhow::Result<Result<(), Refused>> {
        let Some(profile) = profiles::get(&self.db, id).await? else {
            return Ok(Err(Refused::NotFound));
        };
        let mut party = self.stage().party.clone();
        let left = match party.as_mut().map(|party| party::delete_profile(party, id)) {
            Some(Err(message)) => return Ok(Err(Refused::Party(message))),
            Some(Ok(left)) => left,
            None => None,
        };
        let leaving = party
            .clone()
            .zip(left.as_ref().map(|left| left.member.member_id));
        let deleted = self
            .db
            .call(move |conn| {
                let tx = conn.transaction()?;
                if let Some((party, member_id)) = &leaving {
                    store::save_leave_in(&tx, party, *member_id)?;
                }
                let deleted = profiles::delete_in(&tx, id)?;
                tx.commit()?;
                Ok(deleted)
            })
            .await?;
        if !deleted {
            return Ok(Err(Refused::NotFound));
        }
        // The Profile's Score records left the High score tables too.
        self.hub.send_all(&ServerMessage::Changed {
            topics: vec![ChangeTopic::Profiles, ChangeTopic::Library],
        });
        if let (Some(party), Some(left)) = (party, left) {
            let member_id = left.member.member_id;
            self.stage_mut().party = Some(party);
            self.out_of_party(member_id, &left.phones);
            self.party_changed(ChangeEvent {
                actor: Actor::Admin,
                event: PartyEvent::ProfileDeleted {
                    member_id,
                    name: profile.name,
                    avatar: profile.avatar,
                    colour: left.member.colour,
                },
            });
        }
        Ok(Ok(()))
    }

    /// Edits Party member `member_id` inside the Party, from connection
    /// `id` (a Remote command). The colour must be free; for a Profile it
    /// becomes the favourite too, and the name and avatar change the
    /// Profile. A Guest's name may be neither another Guest's nor a
    /// Profile's.
    async fn edit_member(
        &mut self,
        id: ConnectionId,
        member_id: PartyMemberId,
        edit: MemberEdit,
    ) -> Result<(), UserMessage> {
        let actor = self.remote_actor(id)?;
        let mut party = self.party()?;
        let name = edit.name.as_deref().map(profiles::check_name).transpose()?;
        party::edit_member(&mut party, member_id, name.as_ref(), &edit)?;
        let member = party
            .members
            .iter()
            .find(|member| member.member_id == member_id)
            .cloned()
            .ok_or(UserMessage::MemberNotFound)?;
        let party_id = party.party_id.clone();
        let (shown_name, profile_changed) = match &member.identity {
            Identity::Guest { name: guest, .. } => {
                if let Some(name) = &name {
                    self.refuse_profile_name(name).await?;
                }
                let guest = guest.clone();
                self.db
                    .call(move |conn| store::update_member_in(conn, &party_id, &member))
                    .await
                    .map_err(|error| server_error(&error, "storing a Guest edit"))?;
                (guest, false)
            }
            &Identity::Profile { profile_id } => {
                let profile = self
                    .db
                    .call(move |conn| {
                        let tx = conn.transaction()?;
                        let edited = profiles::edit_in(
                            &tx,
                            profile_id,
                            name.as_ref(),
                            edit.avatar,
                            edit.colour,
                        )?;
                        let Ok(profile) = edited else {
                            return Ok(edited.map_err(refusal));
                        };
                        store::update_member_in(&tx, &party_id, &member)?;
                        tx.commit()?;
                        Ok(Ok(profile))
                    })
                    .await
                    .map_err(|error| server_error(&error, "storing a Profile edit"))??;
                (profile.name, true)
            }
        };
        self.stage_mut().party = Some(party);
        if profile_changed {
            self.hub.send_all(&ServerMessage::Changed {
                topics: vec![ChangeTopic::Profiles],
            });
        }
        self.party_changed(ChangeEvent {
            actor,
            event: PartyEvent::MemberChanged {
                member_id,
                name: shown_name,
            },
        });
        Ok(())
    }

    fn refuse_on_error(&mut self, id: ConnectionId, result: Result<(), UserMessage>) {
        if let Err(reason) = result {
            self.reject(id, reason);
        }
    }

    /// The current Party, for a change to it.
    fn party(&self) -> Result<PartySnapshot, UserMessage> {
        self.stage().party.clone().ok_or(UserMessage::NotInParty)
    }

    /// Asks the Library about Song `song_id`.
    async fn lookup_song(&self, song_id: SongId) -> Result<SongLookup, UserMessage> {
        let songs = Arc::clone(&self.songs);
        self.db
            .call(move |conn| songs.lookup(conn, song_id))
            .await
            .map_err(|error| {
                tracing::error!(?error, "looking up a Song for the Queue");
                UserMessage::ServerError
            })
    }

    /// The parameters of a change event about `request`.
    async fn request_change(&self, request: &Request) -> RequestChange {
        let title = self
            .lookup_song(request.song_id)
            .await
            .map(|song| song.title().to_owned())
            .unwrap_or_default();
        RequestChange {
            request_id: request.request_id,
            song_id: request.song_id,
            title,
        }
    }

    /// Adds a Request for `song_id` at the end of the Queue, made from
    /// connection `id`. Only a Song in the Library that is not preparing.
    async fn add_request(
        &mut self,
        id: ConnectionId,
        song_id: SongId,
        requested_players: Option<Vec<PartyMemberId>>,
    ) -> Result<(), UserMessage> {
        let actor = self.remote_actor(id)?;
        let mut party = self.party()?;
        let (requested_players, adder) =
            queue::new_request_players(&party, actor, requested_players)?;
        let title = match self.lookup_song(song_id).await? {
            SongLookup::NotInLibrary => return Err(UserMessage::SongNotInLibrary),
            SongLookup::Preparing { .. } => return Err(UserMessage::SongPreparing),
            SongLookup::Ready { title, .. } => title,
        };
        let mut request = Request {
            request_id: RequestId(0),
            kind: RequestKind::Song,
            song_id,
            requested_players,
            adder,
        };
        request.request_id = store::insert_request(&self.db, &party.party_id, &request)
            .await
            .map_err(|error| {
                tracing::error!(?error, "storing a Request");
                UserMessage::ServerError
            })?;
        let change = RequestChange {
            request_id: request.request_id,
            song_id,
            title,
        };
        queue::add(&mut party, request);
        self.commit_queue(party, actor, PartyEvent::RequestAdded(change))
            .await
    }

    async fn move_request(
        &mut self,
        id: ConnectionId,
        request_id: RequestId,
        to: QueueMove,
    ) -> Result<(), UserMessage> {
        let actor = self.remote_actor(id)?;
        let mut party = self.party()?;
        queue::move_request(&mut party, request_id, to)?;
        let change = self.request_change(queue::find(&party, request_id)?).await;
        let event = match to {
            QueueMove::Up => PartyEvent::RequestMovedUp(change),
            QueueMove::Down => PartyEvent::RequestMovedDown(change),
            QueueMove::Next => PartyEvent::RequestPlayNext(change),
        };
        self.commit_queue(party, actor, event).await
    }

    async fn set_requested_players(
        &mut self,
        id: ConnectionId,
        request_id: RequestId,
        requested_players: Vec<PartyMemberId>,
    ) -> Result<(), UserMessage> {
        let actor = self.remote_actor(id)?;
        let mut party = self.party()?;
        queue::set_players(&mut party, request_id, requested_players)?;
        let change = self.request_change(queue::find(&party, request_id)?).await;
        self.commit_queue(party, actor, PartyEvent::RequestedPlayersChanged(change))
            .await
    }

    async fn remove_request(
        &mut self,
        id: ConnectionId,
        request_id: RequestId,
    ) -> Result<(), UserMessage> {
        let actor = self.remote_actor(id)?;
        let mut party = self.party()?;
        let removed = queue::remove(&mut party, request_id)?;
        let change = self.request_change(&removed).await;
        self.commit_queue(party, actor, PartyEvent::RequestRemoved(change))
            .await
    }

    /// A joined Phone's report that its mic could not open (`blocked`), or
    /// has opened. When that Phone is a seat's Mic, the seat's warning
    /// changes and everyone is told; otherwise nobody hears of it.
    async fn report_mic_blocked(
        &mut self,
        id: ConnectionId,
        blocked: bool,
    ) -> Result<(), UserMessage> {
        let phone_id = self
            .joined_phone(id)
            .ok_or(UserMessage::NotInParty)?
            .phone_id
            .clone();
        let changed = if blocked {
            self.blocked_phones.insert(phone_id.clone())
        } else {
            self.blocked_phones.remove(&phone_id)
        };
        let mic = MicKey::Phone {
            phone_id: phone_id.0,
        };
        let seated = self
            .stage()
            .party
            .as_ref()
            .and_then(|party| party.line_up.as_ref())
            .and_then(|line_up| {
                line_up
                    .seats
                    .iter()
                    .find(|seat| seat.mic.as_ref() == Some(&mic))
            })
            .map(|seat| seat.member_id);
        let (true, Some(member_id)) = (changed, seated) else {
            return Ok(());
        };
        let party = self.party()?;
        let name = self.member_name(&party, member_id).await?;
        let event = if blocked {
            PartyEvent::MicBlocked { member_id, name }
        } else {
            PartyEvent::MicOpened { member_id, name }
        };
        let actor = self.remote_actor(id)?;
        self.party_changed(ChangeEvent { actor, event });
        Ok(())
    }

    /// Leave party: the member of connection `id`'s joined Phone leaves.
    async fn leave_party(&mut self, id: ConnectionId) -> Result<(), UserMessage> {
        let member_id = self
            .joined_phone(id)
            .ok_or(UserMessage::NotInParty)?
            .member_id;
        self.take_out(Actor::Member { member_id }, member_id).await
    }

    /// Removes member `member_id` from the people list, from connection
    /// `id` (a Remote command). A Phone's own member leaves with Leave
    /// party instead.
    async fn remove_member(
        &mut self,
        id: ConnectionId,
        member_id: PartyMemberId,
    ) -> Result<(), UserMessage> {
        let actor = self.remote_actor(id)?;
        if actor == (Actor::Member { member_id }) {
            return Err(UserMessage::UseLeaveParty);
        }
        self.take_out(actor, member_id).await
    }

    /// Member `member_id` leaves the Party (see [`party::leave`]): stored,
    /// then every connection of its Phones is told it left the Party and
    /// everyone hears who left and which colour is free.
    async fn take_out(
        &mut self,
        actor: Actor,
        member_id: PartyMemberId,
    ) -> Result<(), UserMessage> {
        let mut party = self.party()?;
        let left = party::leave(&mut party, member_id)?;
        let (name, avatar) = match &left.member.identity {
            Identity::Guest { name, avatar, .. } => (name.clone(), *avatar),
            &Identity::Profile { profile_id } => {
                let profile = profiles::get(&self.db, profile_id)
                    .await
                    .map_err(|error| server_error(&error, "reading a Profile that leaves"))?
                    .ok_or(UserMessage::ServerError)?;
                (profile.name, profile.avatar)
            }
        };
        store::save_leave(&self.db, &party, member_id)
            .await
            .map_err(|error| server_error(&error, "storing a member leaving"))?;
        self.stage_mut().party = Some(party);
        self.out_of_party(member_id, &left.phones);
        self.party_changed(ChangeEvent {
            actor,
            event: PartyEvent::MemberLeft {
                member_id,
                name,
                avatar,
                colour: left.member.colour,
            },
        });
        Ok(())
    }

    /// After member `member_id` left the current Party (already stored and
    /// applied): forgets what was kept about it and its Phones, and tells
    /// every connection of those Phones that it left the Party.
    fn out_of_party(&mut self, member_id: PartyMemberId, phones: &[PhoneId]) {
        self.stage_mut().last_local_mics.remove(&member_id);
        for phone in phones {
            self.blocked_phones.remove(phone);
        }
        let out: Vec<ConnectionId> = self
            .phones
            .iter()
            .filter(|(_, phone)| phones.contains(phone))
            .map(|(&id, _)| id)
            .collect();
        for id in out {
            self.hub.send_to(id, &ServerMessage::LeftParty);
        }
    }

    /// Edits the waiting Line-up of Request `request_id`, from connection
    /// `id` (a Remote command), stores it and tells everyone. Start
    /// availability and warnings are recomputed before the snapshot goes out.
    async fn edit_line_up(
        &mut self,
        id: ConnectionId,
        request_id: RequestId,
        edit: LineUpEdit,
        now_ms: i64,
    ) -> Result<(), UserMessage> {
        let actor = self.remote_actor(id)?;
        let mut party = self.party()?;
        let mut line_up = party
            .line_up
            .clone()
            .filter(|line_up| line_up.request_id == request_id && party.playing.is_none())
            .ok_or(UserMessage::LineUpNotWaiting)?;
        let index = |seat: u32| usize::try_from(seat).unwrap_or(usize::MAX);
        let event = match edit {
            LineUpEdit::SetWho { seat, who } => {
                return self
                    .seat(party, line_up, Some(index(seat)), who, actor, now_ms)
                    .await;
            }
            LineUpEdit::AddSeat { who } => {
                return self.seat(party, line_up, None, who, actor, now_ms).await;
            }
            LineUpEdit::SetMic { seat, mic } => {
                line_up::set_mic(&party, &mut line_up, index(seat), mic, &self.local_mics)?;
                PartyEvent::LineUpChanged
            }
            LineUpEdit::SetVoice { seat, voice } => {
                let member_id = line_up::set_voice(&mut line_up, index(seat), voice)?.member_id;
                let name = self.member_name(&party, member_id).await?;
                PartyEvent::SeatVoice {
                    member_id,
                    name,
                    voice,
                }
            }
            LineUpEdit::SetDifficulty { seat, difficulty } => {
                let member_id =
                    line_up::set_difficulty(&mut line_up, index(seat), difficulty)?.member_id;
                let name = self.member_name(&party, member_id).await?;
                PartyEvent::SeatDifficulty {
                    member_id,
                    name,
                    difficulty,
                }
            }
            LineUpEdit::RemoveSeat { seat } => {
                line_up::remove_seat(&mut line_up, index(seat))?;
                PartyEvent::LineUpChanged
            }
        };
        party.line_up = Some(line_up);
        self.commit_queue(party, actor, event).await
    }

    /// Seats `who` in `seat` of `line_up` (a new last seat when `None`),
    /// entering it into the Party first when it is not a member: an
    /// existing Profile, a new Guest or a new Profile created in the same
    /// transaction. Stores it and tells everyone; a refusal changes and
    /// creates nothing.
    async fn seat(
        &mut self,
        mut party: PartySnapshot,
        mut line_up: LineUp,
        seat: Option<usize>,
        who: SeatWho,
        actor: Actor,
        now_ms: i64,
    ) -> Result<(), UserMessage> {
        let entering = match who {
            SeatWho::Member { member_id } => Entering::Member(member_id),
            SeatWho::Profile { profile_id } => {
                let profile = profiles::get(&self.db, profile_id)
                    .await
                    .map_err(|error| server_error(&error, "reading a Profile to seat"))?
                    .ok_or(UserMessage::ProfileNotFound)?;
                Entering::Profile {
                    profile_id,
                    favourite: profile.favourite_colour,
                }
            }
            SeatWho::Guest(guest) => {
                let name = profiles::check_name(&guest.name)?;
                self.refuse_profile_name(&name).await?;
                Entering::Guest { name, guest }
            }
            SeatWho::NewProfile(new) => {
                let name = profiles::check_name(&new.name)?;
                refuse_new_profile(&party, &name)?;
                Entering::NewProfile { name, new }
            }
        };
        let last_difficulties: HashMap<ProfileId, Difficulty> = profiles::list(&self.db)
            .await
            .map_err(|error| server_error(&error, "reading Profiles for a Line-up"))?
            .into_iter()
            .map(|profile| (profile.id, profile.last_difficulty))
            .collect();
        let mics = line_up::MicChoices {
            local_mics: self.local_mics.clone(),
            last_local_mics: self.stage().last_local_mics.clone(),
        };
        let (party, seating) = self
            .db
            .call(move |conn| {
                let tx = conn.transaction()?;
                let entered = match entering {
                    Entering::Member(member_id) => Ok((member_id, false, false)),
                    Entering::Profile {
                        profile_id,
                        favourite,
                    } => party::enter_profile(&mut party, profile_id, favourite)
                        .map(|joined| (joined.member_id, joined.new_member, false)),
                    Entering::Guest { name, guest } => {
                        party::enter_guest(&mut party, &name, guest.colour, guest.avatar)
                            .map(|member_id| (member_id, true, false))
                    }
                    Entering::NewProfile { name, new } => {
                        match profiles::create_in(&tx, &name, &new, now_ms)? {
                            Ok(profile) => party::enter_profile(
                                &mut party,
                                profile.id,
                                profile.favourite_colour,
                            )
                            .map(|joined| (joined.member_id, joined.new_member, true)),
                            Err(refused) => Err(refusal(refused)),
                        }
                    }
                };
                let (member_id, new_member, created) = match entered {
                    Ok(entered) => entered,
                    Err(refused) => return Ok(Err(refused)),
                };
                let seated = match line_up::seat_member(
                    &party,
                    &mut line_up,
                    seat,
                    member_id,
                    &last_difficulties,
                    &mics,
                ) {
                    Ok(seated) => seated,
                    Err(refused) => return Ok(Err(refused)),
                };
                party.line_up = Some(line_up);
                let member = party
                    .members
                    .iter()
                    .find(|member| new_member && member.member_id == member_id);
                store::save_seating_in(&tx, &party, member)?;
                tx.commit()?;
                Ok(Ok((
                    party,
                    Seating {
                        member_id,
                        new_member,
                        moved: seated.moved,
                        created,
                    },
                )))
            })
            .await
            .map_err(|error| server_error(&error, "storing a Line-up seat"))??;
        let member_id = seating.member_id;
        let name = self.member_name(&party, member_id).await?;
        let event = if seating.new_member {
            let colour = party
                .members
                .iter()
                .find(|member| member.member_id == member_id)
                .map(|member| member.colour)
                .ok_or(UserMessage::ServerError)?;
            PartyEvent::MemberJoined {
                member_id,
                name,
                colour,
            }
        } else if seating.moved {
            PartyEvent::SeatMoved { member_id, name }
        } else {
            PartyEvent::LineUpChanged
        };
        self.stage_mut().party = Some(party);
        if seating.created {
            self.hub.send_all(&ServerMessage::Changed {
                topics: vec![ChangeTopic::Profiles],
            });
        }
        self.party_changed(ChangeEvent { actor, event });
        Ok(())
    }

    /// "My Difficulty for the next Song" from connection `id`'s joined
    /// Phone: its member's seat when seated, otherwise the Difficulty its
    /// next seat starts at (a Guest's Party Difficulty, a Profile's last
    /// Difficulty).
    async fn set_my_difficulty(
        &mut self,
        id: ConnectionId,
        difficulty: Difficulty,
    ) -> Result<(), UserMessage> {
        let member_id = self
            .joined_phone(id)
            .ok_or(UserMessage::NotInParty)?
            .member_id;
        let actor = Actor::Member { member_id };
        let mut party = self.party()?;
        let name = self.member_name(&party, member_id).await?;
        if party.playing.is_some()
            && party
                .members
                .iter()
                .any(|m| m.member_id == member_id && m.singing)
        {
            return Err(UserMessage::DifficultyLocked);
        }
        let seated = party.line_up.as_mut().is_some_and(|line_up| {
            let mut seated = false;
            for seat in &mut line_up.seats {
                if seat.member_id == member_id {
                    seat.difficulty = difficulty;
                    seated = true;
                }
            }
            seated
        });
        if seated {
            let event = PartyEvent::SeatDifficulty {
                member_id,
                name,
                difficulty,
            };
            return self.commit_queue(party, actor, event).await;
        }
        let member = party
            .members
            .iter_mut()
            .find(|member| member.member_id == member_id)
            .ok_or(UserMessage::MemberNotFound)?;
        match &mut member.identity {
            Identity::Guest {
                difficulty: next, ..
            } => {
                *next = difficulty;
                let party_id = party.party_id.clone();
                let member = member.clone();
                self.db
                    .call(move |conn| store::update_member_in(conn, &party_id, &member))
                    .await
                    .map_err(|error| server_error(&error, "storing a Guest's Difficulty"))?;
            }
            &mut Identity::Profile { profile_id } => {
                profiles::set_last_difficulty(&self.db, profile_id, difficulty)
                    .await
                    .map_err(|error| server_error(&error, "storing a Profile's Difficulty"))?;
                self.hub.send_all(&ServerMessage::Changed {
                    topics: vec![ChangeTopic::Profiles],
                });
            }
        }
        self.stage_mut().party = Some(party);
        self.party_changed(ChangeEvent {
            actor,
            event: PartyEvent::NextDifficulty {
                member_id,
                name,
                difficulty,
            },
        });
        Ok(())
    }

    /// Start, Pause, Resume, Restart, End or Skip for Request `request_id`'s
    /// Song, from connection `id` (a Remote command). Everyone hears the
    /// change, then the Stage is told to act on it.
    async fn control_song(
        &mut self,
        id: ConnectionId,
        request_id: RequestId,
        control: SongControl,
    ) -> Result<(), UserMessage> {
        let actor = self.remote_actor(id)?;
        let mut party = self.party()?;
        if control == SongControl::Start {
            return self.start_song(actor, party, request_id).await;
        }
        let playing = party
            .playing
            .clone()
            .filter(|playing| playing.request_id == request_id)
            .ok_or(UserMessage::NoSongPlaying)?;
        let change = self.request_change(queue::find(&party, request_id)?).await;
        let paused = |party: &mut PartySnapshot, paused: bool| {
            if let Some(playing) = party.playing.as_mut() {
                playing.paused = paused;
            }
        };
        let event = match control {
            SongControl::Start => unreachable!("Start is handled above"),
            SongControl::Pause | SongControl::Resume => {
                let pause = control == SongControl::Pause;
                if playing.paused == pause {
                    return Ok(());
                }
                paused(&mut party, pause);
                if pause {
                    PartyEvent::SongPaused(change)
                } else {
                    PartyEvent::SongResumed(change)
                }
            }
            SongControl::Restart => {
                paused(&mut party, false);
                PartyEvent::SongRestarted(change)
            }
            SongControl::End => PartyEvent::SongEnded(change),
            SongControl::Skip => {
                party.playing = None;
                queue::remove(&mut party, request_id)?;
                self.commit_queue(party, actor, PartyEvent::SongSkipped(change))
                    .await?;
                self.tell_stage(request_id, playing.song_id, control);
                return Ok(());
            }
        };
        // Pausing and the like change nothing that is stored: a Song in
        // progress is never kept.
        self.stage_mut().party = Some(party);
        self.party_changed(ChangeEvent { actor, event });
        self.tell_stage(request_id, playing.song_id, control);
        Ok(())
    }

    /// Start: the waiting Line-up of Request `request_id` begins its Song as
    /// it stands, if it can start and a Stage is open. It does not wait for
    /// any Phone's mic. Each seat's Local mic is remembered as the Local
    /// mic its member last sang on in this Party.
    async fn start_song(
        &mut self,
        actor: Actor,
        mut party: PartySnapshot,
        request_id: RequestId,
    ) -> Result<(), UserMessage> {
        let mut line_up = party
            .line_up
            .clone()
            .filter(|line_up| line_up.request_id == request_id && party.playing.is_none())
            .ok_or(UserMessage::LineUpNotWaiting)?;
        line_up::check(&mut line_up, &self.blocked_phones);
        if !line_up.can_start {
            return Err(UserMessage::LineUpNotReady);
        }
        if self.stage().connection.is_none() {
            return Err(UserMessage::NoStage);
        }
        let request = queue::find(&party, request_id)?.clone();
        let change = self.request_change(&request).await;
        let sung: Vec<(PartyMemberId, String)> = line_up
            .seats
            .iter()
            .filter_map(|seat| match &seat.mic {
                Some(MicKey::LocalMic { local_mic_id }) => {
                    Some((seat.member_id, local_mic_id.clone()))
                }
                _ => None,
            })
            .collect();
        if !sung.is_empty() {
            store::save_last_local_mics(&self.db, &party.party_id, sung.clone())
                .await
                .map_err(|error| server_error(&error, "storing the Local mics sung on"))?;
        }
        party.playing = Some(PlayingSong {
            request_id,
            song_id: request.song_id,
            paused: false,
        });
        let stage = self.stage_mut();
        stage.last_local_mics.extend(sung);
        stage.party = Some(party);
        self.party_changed(ChangeEvent {
            actor,
            event: PartyEvent::SongStarted(change),
        });
        self.tell_stage(request_id, request.song_id, SongControl::Start);
        Ok(())
    }

    /// The Stage reports that Request `request_id`'s Song reached its
    /// results screen: the Request leaves the Queue and the Party shows its
    /// results, with no head, until Next or Done.
    async fn reached_results(
        &mut self,
        id: ConnectionId,
        request_id: RequestId,
        ended: SongEnd,
    ) -> Result<(), UserMessage> {
        if self.stage().connection != Some(id) {
            return Err(UserMessage::NotTheStage);
        }
        let mut party = self.party()?;
        let playing = party
            .playing
            .take()
            .filter(|playing| playing.request_id == request_id)
            .ok_or(UserMessage::NoSongPlaying)?;
        let removed = queue::remove(&mut party, request_id)?;
        let change = self.request_change(&removed).await;
        party.head = None;
        party.results = Some(SongResults {
            request_id,
            song_id: playing.song_id,
            ended,
        });
        self.commit_queue(party, Actor::Stage, PartyEvent::ResultsShown(change))
            .await
    }

    /// Next, or Done with an empty Queue, on the results, from connection
    /// `id` (a Remote command): the next Request becomes the head with its
    /// Line-up prefilled, or the song browser shows.
    async fn close_results(&mut self, id: ConnectionId) -> Result<(), UserMessage> {
        let actor = self.remote_actor(id)?;
        let mut party = self.party()?;
        party.results.take().ok_or(UserMessage::NoResults)?;
        party.head = party.queue.first().map(|request| request.request_id);
        self.commit_queue(party, actor, PartyEvent::ResultsClosed)
            .await
    }

    /// Songs left the Library: every queued Request for one of them, except
    /// the playing Request, leaves the Queue, one change event each, naming
    /// the Song by the title it had in the Library.
    async fn songs_left(&mut self, songs: Vec<(SongId, String)>) {
        let titles: HashMap<SongId, String> = songs.into_iter().collect();
        loop {
            let Some(mut party) = self.stage().party.clone() else {
                return;
            };
            let playing = party.playing.as_ref().map(|playing| playing.request_id);
            let Some(request) = party
                .queue
                .iter()
                .find(|request| {
                    titles.contains_key(&request.song_id) && Some(request.request_id) != playing
                })
                .cloned()
            else {
                return;
            };
            if let Err(error) = queue::remove(&mut party, request.request_id) {
                tracing::error!(?error, "dropping a Request whose Song left the Library");
                return;
            }
            let change = RequestChange {
                request_id: request.request_id,
                song_id: request.song_id,
                title: titles[&request.song_id].clone(),
            };
            if self
                .commit_queue(
                    party,
                    Actor::Admin,
                    PartyEvent::RequestDroppedSongGone(change),
                )
                .await
                .is_err()
            {
                // Logged by `commit_queue`; the Request stays queued.
                return;
            }
        }
    }

    /// Whether Song `song_id` plays on the Stage now.
    fn song_playing(&self, song_id: SongId) -> bool {
        self.stage()
            .party
            .as_ref()
            .and_then(|party| party.playing.as_ref())
            .is_some_and(|playing| playing.song_id == song_id)
    }

    /// Tells the active Stage to act on the head's Song.
    fn tell_stage(&mut self, request_id: RequestId, song_id: SongId, control: SongControl) {
        self.send_to_stage(&ServerMessage::ControlSong {
            request_id,
            song_id,
            control,
        });
    }

    /// The name member `member_id` of `party` goes by now.
    async fn member_name(
        &self,
        party: &PartySnapshot,
        member_id: PartyMemberId,
    ) -> Result<String, UserMessage> {
        let member = party
            .members
            .iter()
            .find(|member| member.member_id == member_id)
            .ok_or(UserMessage::MemberNotFound)?;
        match &member.identity {
            Identity::Guest { name, .. } => Ok(name.clone()),
            &Identity::Profile { profile_id } => Ok(profiles::get(&self.db, profile_id)
                .await
                .map_err(|error| server_error(&error, "reading a Profile's name"))?
                .map(|profile| profile.name)
                .unwrap_or_default()),
        }
    }

    /// Prefills the Line-up of `party`'s head when the head is a Request
    /// that has none yet (it just reached the head), and drops it when
    /// there is no head. A Line-up already waiting is kept as it is.
    async fn follow_head(&self, party: &mut PartySnapshot) -> Result<(), UserMessage> {
        let Some(head) = party.head else {
            party.line_up = None;
            return Ok(());
        };
        if party.line_up.as_ref().map(|line_up| line_up.request_id) == Some(head) {
            return Ok(());
        }
        let request = queue::find(party, head)?.clone();
        let duet = self.lookup_song(request.song_id).await?.duet();
        let last_difficulties = profiles::list(&self.db)
            .await
            .map_err(|error| server_error(&error, "reading Profiles for a Line-up"))?
            .into_iter()
            .map(|profile| (profile.id, profile.last_difficulty))
            .collect();
        let mics = line_up::MicChoices {
            local_mics: self.local_mics.clone(),
            last_local_mics: self.stage().last_local_mics.clone(),
        };
        party.line_up = Some(line_up::prefill(
            party,
            &request,
            duet,
            &last_difficulties,
            &mics,
        ));
        Ok(())
    }

    /// Stores the changed Queue of `party` (with the Line-up of its head,
    /// prefilled when a Request just reached it), makes it the current
    /// Party and tells everyone. Nothing changes when it cannot be stored.
    async fn commit_queue(
        &mut self,
        mut party: PartySnapshot,
        actor: Actor,
        event: PartyEvent,
    ) -> Result<(), UserMessage> {
        self.follow_head(&mut party).await?;
        store::save_queue(&self.db, &party).await.map_err(|error| {
            tracing::error!(?error, "storing the Queue");
            UserMessage::ServerError
        })?;
        self.stage_mut().party = Some(party);
        self.party_changed(ChangeEvent { actor, event });
        Ok(())
    }

    /// Tells every connection the whole Party after an accepted change, plus
    /// the change itself. The Line-up's Start availability and warnings are
    /// checked first, so every snapshot sent carries them up to date.
    fn party_changed(&mut self, change: ChangeEvent) {
        let blocked = self.blocked_phones.clone();
        let Some(party) = self.stage_mut().party.as_mut() else {
            return;
        };
        refresh_computed(party, &blocked);
        let party = party.clone();
        self.hub
            .send_all(&ServerMessage::PartyChanged { party, change });
    }

    /// Sends a Stage-only message to the active Stage alone, if one is open.
    /// A Stage that moved no longer receives these. With no Stage the
    /// message is dropped, not queued.
    fn send_to_stage(&mut self, message: &ServerMessage) {
        if let Some(id) = self.stage().connection {
            self.hub.send_to(id, message);
        }
    }

    fn reject(&mut self, id: ConnectionId, reason: UserMessage) {
        self.hub.send_to(id, &ServerMessage::Rejected { reason });
    }
}

/// Recomputes what the server derives in a snapshot: the Line-up's Start
/// availability and warnings, and which members are singing.
fn refresh_computed(party: &mut PartySnapshot, blocked_phones: &HashSet<PhoneId>) {
    let playing = party.playing.is_some();
    if let Some(line_up) = party.line_up.as_mut() {
        line_up::check(line_up, blocked_phones);
        // A Line-up whose Song plays cannot start again.
        line_up.can_start &= !playing;
    }
    line_up::refresh_singing(party);
}

/// Who takes a Line-up seat, once checked against the database: a member,
/// or someone who enters the Party with the seat.
enum Entering {
    Member(PartyMemberId),
    Profile {
        profile_id: ProfileId,
        favourite: openstar_protocol::profile::PaletteKey,
    },
    Guest {
        name: profiles::CheckedName,
        guest: openstar_protocol::NewGuest,
    },
    NewProfile {
        name: profiles::CheckedName,
        new: NewProfile,
    },
}

/// What seating someone on the Line-up did.
struct Seating {
    member_id: PartyMemberId,
    /// The member entered the Party with this seat.
    new_member: bool,
    /// The member sat in another seat, which was taken off.
    moved: bool,
    /// A new Profile was created for the seat.
    created: bool,
}

/// Refuses a new Profile named `name` in `party`: a Guest has the name, or
/// twelve colours are held.
fn refuse_new_profile(
    party: &PartySnapshot,
    name: &profiles::CheckedName,
) -> Result<(), UserMessage> {
    if let Some(member_id) = party::guest_named(party, &name.key, None) {
        return Err(UserMessage::NameTakenTonight { member_id });
    }
    if party::is_full(party) {
        return Err(UserMessage::PartyFull);
    }
    Ok(())
}

/// The refusal code a Phone gets for a refused Profile create or edit.
fn refusal(refused: Refused) -> UserMessage {
    match refused {
        Refused::Name(message) | Refused::Party(message) => message,
        Refused::Taken(profile_id) => UserMessage::ProfileNameTaken { profile_id },
        Refused::NotFound => UserMessage::ProfileNotFound,
    }
}

/// Logs a failed storage step and answers with [`UserMessage::ServerError`].
fn server_error(error: &anyhow::Error, doing: &str) -> UserMessage {
    tracing::error!(?error, "{doing}");
    UserMessage::ServerError
}

/// The Mic a connection's readings and pings come from. Until Phones join
/// with a Phone id (#81), a Phone's Mic is named by its connection.
/// Whether `local_mic_id` may be kept with `source`: a bridge Local mic's id
/// is always the one [`bridge_local_mic_id`] makes from its source, so a
/// Stage cannot store a bridge channel under another id. A browser Local
/// mic's id is made by the Stage and kept as sent.
fn local_mic_id_fits(local_mic_id: &str, source: &LocalMicSource) -> bool {
    match source {
        LocalMicSource::Bridge {
            bridge_id,
            device_name,
            channel,
            ..
        } => local_mic_id == bridge_local_mic_id(bridge_id, device_name, *channel),
        LocalMicSource::Browser { .. } => true,
    }
}

fn mic_id(id: ConnectionId) -> MicId {
    MicId::Phone { connection: id }
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
    async fn only_the_stage_and_joined_phones_may_make_remote_commands() {
        use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey};
        use openstar_protocol::{PartyMemberId, PhoneId};

        let (mut state, _dir) = state().await;
        let stage = state.connect(Role::Stage, 1).await;
        let browser = state.connect(Role::Browser, 1).await;
        let hello_only = state.connect(Role::Browser, 1).await;
        let joined = state.connect(Role::Browser, 1).await;
        let profile = profiles::create(
            &state.db,
            NewProfile {
                name: "Bo".into(),
                avatar: Avatar::BuiltIn {
                    key: AvatarKey::Star,
                },
                favourite_colour: PaletteKey::Sky,
            },
            1,
        )
        .await
        .unwrap()
        .unwrap();
        let join_code = state.stage().party.as_ref().unwrap().join_code.clone();

        let phone = |n: u32| PhoneId(format!("phone-{n}"));
        state
            .received(
                hello_only.id,
                2,
                Ok(ClientMessage::Hello { phone_id: phone(1) }),
            )
            .await;
        state
            .received(
                joined.id,
                2,
                Ok(ClientMessage::Join {
                    phone_id: phone(2),
                    join_code,
                    join_as: JoinAs::Profile {
                        profile_id: profile.id,
                    },
                }),
            )
            .await;

        assert_eq!(state.remote_actor(stage.id), Ok(Actor::Stage));
        assert_eq!(
            state.remote_actor(joined.id),
            Ok(Actor::Member {
                member_id: PartyMemberId(1)
            })
        );
        assert_eq!(state.remote_actor(browser.id), Err(UserMessage::NotInParty));
        assert_eq!(
            state.remote_actor(hello_only.id),
            Err(UserMessage::NotInParty)
        );

        // New party puts every Phone out of the Party.
        state
            .received(stage.id, 3, Ok(ClientMessage::NewParty))
            .await;
        assert_eq!(state.remote_actor(joined.id), Err(UserMessage::NotInParty));
    }

    /// A Library where Song 1 is ready, Song 2 is preparing and nothing else exists.
    struct StubSongs;

    impl Songs for StubSongs {
        fn lookup(&self, _conn: &rusqlite::Connection, id: SongId) -> rusqlite::Result<SongLookup> {
            Ok(match id.0 {
                1 => SongLookup::Ready {
                    title: "Africa".into(),
                    duet: false,
                },
                2 => SongLookup::Preparing {
                    title: "Rosanna".into(),
                },
                _ => SongLookup::NotInLibrary,
            })
        }
    }

    #[tokio::test]
    async fn a_song_the_library_reports_as_preparing_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let opened = Database::open(dir.path()).await.unwrap();
        let mut state = LiveState::load_with(opened.database, Arc::new(StubSongs))
            .await
            .unwrap();
        let mut stage = state.connect(Role::Stage, 1).await;
        drain(&mut stage);
        let add = |n| {
            Ok(ClientMessage::AddRequest {
                song_id: SongId(n),
                requested_players: None,
            })
        };

        state.received(stage.id, 2, add(2)).await;
        assert_eq!(
            drain(&mut stage),
            vec![ServerMessage::Rejected {
                reason: UserMessage::SongPreparing
            }]
        );
        state.received(stage.id, 2, add(3)).await;
        assert_eq!(
            drain(&mut stage),
            vec![ServerMessage::Rejected {
                reason: UserMessage::SongNotInLibrary
            }]
        );
        state.received(stage.id, 2, add(1)).await;
        let party = state.stage().party.clone().unwrap();
        assert_eq!(party.queue.len(), 1);
        assert!(matches!(
            &drain(&mut stage)[..],
            [ServerMessage::PartyChanged {
                change: ChangeEvent {
                    event: PartyEvent::RequestAdded(RequestChange { title, .. }),
                    ..
                },
                ..
            }] if title == "Africa"
        ));
    }

    #[tokio::test]
    async fn the_local_mic_a_member_last_sang_on_survives_a_restart_and_new_party_forgets_it() {
        use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey};

        let dir = tempfile::tempdir().unwrap();
        let opened = Database::open(dir.path()).await.unwrap();
        let db = opened.database;
        let mut state = LiveState::load_with(db.clone(), Arc::new(StubSongs))
            .await
            .unwrap();
        let _stage = state.connect(Role::Stage, 1).await;
        let phone = state.connect(Role::Browser, 1).await;
        let profile = profiles::create(
            &db,
            NewProfile {
                name: "Bo".into(),
                avatar: Avatar::BuiltIn {
                    key: AvatarKey::Star,
                },
                favourite_colour: PaletteKey::Sky,
            },
            1,
        )
        .await
        .unwrap()
        .unwrap();
        let join_code = state.stage().party.as_ref().unwrap().join_code.clone();
        state
            .received(
                phone.id,
                2,
                Ok(ClientMessage::Join {
                    phone_id: PhoneId("phone-1".into()),
                    join_code,
                    join_as: JoinAs::Profile {
                        profile_id: profile.id,
                    },
                }),
            )
            .await;
        let party_id = state.stage().party.as_ref().unwrap().party_id.clone();
        store::save_last_local_mic(&db, &party_id, PartyMemberId(1), "blue")
            .await
            .unwrap();

        // After a restart, Bo's seat is prefilled with the Local mic Bo last
        // sang on, before the first free one and before Bo's Phone.
        drop(state);
        let mut state = LiveState::load_with(db.clone(), Arc::new(StubSongs))
            .await
            .unwrap();
        state.local_mics = vec!["red".into(), "blue".into()];
        let stage = state.connect(Role::Stage, 3).await;
        let phone = state.connect(Role::Browser, 3).await;
        state
            .received(
                phone.id,
                3,
                Ok(ClientMessage::Hello {
                    phone_id: PhoneId("phone-1".into()),
                }),
            )
            .await;
        let add = Ok(ClientMessage::AddRequest {
            song_id: SongId(1),
            requested_players: None,
        });
        state.received(phone.id, 4, add.clone()).await;
        let seat_mic = |state: &LiveState| {
            state
                .stage()
                .party
                .as_ref()
                .unwrap()
                .line_up
                .as_ref()
                .unwrap()
                .seats[0]
                .mic
                .clone()
        };
        assert_eq!(
            seat_mic(&state),
            Some(MicKey::LocalMic {
                local_mic_id: "blue".into()
            })
        );

        state
            .received(stage.id, 5, Ok(ClientMessage::NewParty))
            .await;
        assert!(state.stage().last_local_mics.is_empty());
        drop(state);
        let state = LiveState::load_with(db.clone(), Arc::new(StubSongs))
            .await
            .unwrap();
        assert!(state.stage().last_local_mics.is_empty());
        drop(stage);
    }

    #[tokio::test]
    async fn start_records_each_seats_local_mic_as_the_one_its_member_last_sang_on() {
        use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey};

        let dir = tempfile::tempdir().unwrap();
        let opened = Database::open(dir.path()).await.unwrap();
        let db = opened.database;
        let mut state = LiveState::load_with(db.clone(), Arc::new(StubSongs))
            .await
            .unwrap();
        state.local_mics = vec!["red".into()];
        let stage = state.connect(Role::Stage, 1).await;
        let phone = state.connect(Role::Browser, 1).await;
        let profile = profiles::create(
            &db,
            NewProfile {
                name: "Bo".into(),
                avatar: Avatar::BuiltIn {
                    key: AvatarKey::Star,
                },
                favourite_colour: PaletteKey::Sky,
            },
            1,
        )
        .await
        .unwrap()
        .unwrap();
        let join_code = state.stage().party.as_ref().unwrap().join_code.clone();
        state
            .received(
                phone.id,
                2,
                Ok(ClientMessage::Join {
                    phone_id: PhoneId("phone-1".into()),
                    join_code,
                    join_as: JoinAs::Profile {
                        profile_id: profile.id,
                    },
                }),
            )
            .await;
        state
            .received(
                phone.id,
                3,
                Ok(ClientMessage::AddRequest {
                    song_id: SongId(1),
                    requested_players: None,
                }),
            )
            .await;
        assert!(
            !state.song_playing(SongId(1)),
            "a queued Song does not play yet"
        );
        let party = state.stage().party.clone().unwrap();
        let request_id = party.head.unwrap();
        // Bo has never sung, so the seat takes the first free Local mic.
        assert_eq!(
            party.line_up.unwrap().seats[0].mic,
            Some(MicKey::LocalMic {
                local_mic_id: "red".into()
            })
        );
        assert!(state.stage().last_local_mics.is_empty());

        state
            .received(
                stage.id,
                4,
                Ok(ClientMessage::ControlSong {
                    request_id,
                    control: SongControl::Start,
                }),
            )
            .await;
        assert!(state.stage().party.as_ref().unwrap().playing.is_some());
        // The Party answers whether a Song plays: a Song delete asks it.
        assert!(state.song_playing(SongId(1)));
        assert!(!state.song_playing(SongId(2)));
        let remembered = HashMap::from([(PartyMemberId(1), "red".to_owned())]);
        assert_eq!(state.stage().last_local_mics, remembered);
        drop(state);
        let state = LiveState::load_with(db.clone(), Arc::new(StubSongs))
            .await
            .unwrap();
        assert_eq!(state.stage().last_local_mics, remembered);
    }

    #[tokio::test]
    async fn the_handle_answers_that_nothing_plays_without_a_song() {
        let dir = tempfile::tempdir().unwrap();
        let opened = Database::open(dir.path()).await.unwrap();
        let live = LiveHandle::start(opened.database).await.unwrap();
        assert!(!live.song_playing(SongId(1)).await);
        live.shutdown().await;
        assert!(
            !live.song_playing(SongId(1)).await,
            "a stopped task plays nothing"
        );
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
