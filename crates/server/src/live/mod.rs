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
//! from (a Phone's Mic is its Phone id, so a seat names it), and are dropped
//! while there is no Stage or the browser presented no Phone id; the Stage's
//! pongs go back to the connection that last spoke for that Mic. The relay never changes a reading, never scores
//! and never touches SQLite.

mod av_sync;
mod bridges;
mod calibration;
pub mod connection;
mod forget_bridge;
pub mod hub;
mod line_up;
mod local_mic_list;
mod party;
mod queue;
mod songs;
mod store;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use openstar_protocol::bridge::{BridgeId, bridge_local_mic_id};
use openstar_protocol::library::SongId;
use openstar_protocol::mics::{LocalMic, LocalMicSource, MicKey, PartyLocalMic};
use openstar_protocol::profile::{Difficulty, NewProfile, Profile, ProfileEdit, ProfileId};
use openstar_protocol::volume::VolumeStep;
use openstar_protocol::{
    Actor, BridgeLocalMic, ChangeEvent, ChangeTopic, ClientMessage, Identity, JoinAs, JoinCode,
    JoinedPhone, LineUp, LineUpEdit, MemberEdit, MicId, PartyEvent, PartyMember, PartyMemberId,
    PartySnapshot, PhoneId, PlayingSong, QueueMove, Request, RequestChange, RequestId, RequestKind,
    SeatVoice, SeatWho, ServerMessage, SongControl, SongEnd, SongProgress, SongResults, StageId,
    UserMessage,
};
use tokio::sync::{mpsc, oneshot};

use crate::db::Database;
use crate::profiles::{self, Refused};
use crate::scores;
use crate::stage_outputs::{self, StageOutput};
use hub::{Connection, ConnectionId, Hub};
use openstar_protocol::scoring::{
    PlayerResult, RoundEnd, RoundOutcome, RoundStored, ScorePlayer, StoredRound,
};
use party::Joined;
use songs::{LibraryIndex, SongLookup, Songs};

/// The one Stage id in use in v1.
pub const MAIN_STAGE: &str = "main";

/// How many commands may wait for the task.
const COMMAND_CAPACITY: usize = 1024;

/// The highest Score a Player can reach.
const MAX_TOTAL: u32 = 10_000;

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
    /// A Phone's Auto-fit of Song `song_id` (titled `title`) was saved: the
    /// Stage toasts it, naming the Phone's Party member.
    AutoFitAccepted {
        phone_id: PhoneId,
        song_id: SongId,
        title: String,
    },
    /// Whether Song `song_id` plays on the Stage now (a Timing edit's save,
    /// Restore Original and a Song delete are refused then).
    SongPlaying {
        song_id: SongId,
        reply: oneshot::Sender<bool>,
    },
    /// When Song `song_id` last started on the Stage (server time, ms), if
    /// it has since the server started.
    SongLastStarted {
        song_id: SongId,
        reply: oneshot::Sender<Option<i64>>,
    },
    /// The Admin area deletes a Profile: a Party member leaves the Party
    /// first, in the same transaction. Refused while it sings in the
    /// playing Song.
    DeleteProfile {
        id: ProfileId,
        reply: oneshot::Sender<anyhow::Result<Result<(), Refused>>>,
    },
    /// `DELETE /api/mic-bridges/{id}`: forgets an approved bridge.
    ForgetBridge {
        bridge_id: openstar_protocol::bridge::BridgeId,
        reply: oneshot::Sender<anyhow::Result<bool>>,
    },
    /// `GET /api/mic-bridges`: approved bridges and those waiting.
    MicBridges {
        reply: oneshot::Sender<openstar_protocol::bridge::MicBridges>,
    },
    /// `POST /api/rounds`: the Stage's outcome of the Song that just ended
    /// (see [`LiveState::finish_round`]).
    FinishRound {
        outcome: RoundOutcome,
        now_ms: i64,
        reply: oneshot::Sender<anyhow::Result<Result<RoundStored, scores::Refused>>>,
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

    /// Tells the Party that Phone `phone_id`'s Auto-fit of Song `song_id`
    /// was saved (see [`Command::AutoFitAccepted`]).
    pub async fn auto_fit_accepted(&self, phone_id: PhoneId, song_id: SongId, title: String) {
        let _ = self
            .commands
            .send(Command::AutoFitAccepted {
                phone_id,
                song_id,
                title,
            })
            .await;
    }

    /// Whether Song `song_id` plays on the Stage now; false once the task
    /// has stopped. A Timing edit's save and Restore Original ask, and
    /// #190's Song delete.
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

    /// When Song `song_id` last started on the Stage (server time, ms);
    /// `None` if it has not since the server started, or once the task has
    /// stopped. A Timing edit's save asks.
    pub async fn song_last_started(&self, song_id: SongId) -> Option<i64> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::SongLastStarted { song_id, reply })
            .await
            .ok()?;
        answer.await.ok().flatten()
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

    /// Stores the outcome of the Song that just ended and, unless it was a
    /// skip, shows its results (see [`Command::FinishRound`]).
    pub async fn finish_round(
        &self,
        outcome: RoundOutcome,
        now_ms: i64,
    ) -> anyhow::Result<Result<RoundStored, scores::Refused>> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::FinishRound {
                outcome,
                now_ms,
                reply,
            })
            .await
            .map_err(|_| anyhow::anyhow!("the live-state task has stopped"))?;
        answer.await?
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
    /// The active Stage's latest position report for the playing Song, and
    /// when it arrived (ms). Passed on only while its Request still plays.
    progress: Option<(SongProgress, i64)>,
    /// Check A/V sync runs on the active Stage (`av_sync.rs`).
    av_sync: bool,
    /// What is known about the running check: the Phone that started it
    /// (`None` for the Stage) and the Stage's reported A/V offset.
    av_sync_check: av_sync::AvSyncCheck,
    /// The open Calibrate mics run (`calibration.rs`).
    calibration: Option<calibration::Calibration>,
}

/// Owned by the task alone.
struct LiveState {
    db: Database,
    /// The Stage every connection is attached to: the one in use.
    current_stage: StageId,
    stages: HashMap<StageId, Stage>,
    hub: Hub,
    /// Phone Mics: each Phone whose connection has sent a Pitch reading or
    /// a clock ping, with the connection that sent the latest one. Pongs go
    /// to that connection, and its close is reported to the Stage.
    mics: HashMap<PhoneId, ConnectionId>,
    /// The Phone id each connection presented. Kept for the connection's
    /// life, whether or not that Phone is in the Party, so a Phone told it
    /// left can join again on the same connection.
    phones: HashMap<ConnectionId, PhoneId>,
    /// Whether a Song is in the Library and can be queued.
    songs: Arc<dyn Songs>,
    /// The Local mics that are switched on and present, in Mics-screen
    /// order: what the Line-up's Mic prefill and `setMic` may choose.
    local_mics: Vec<String>,
    /// Every kept Local mic, as last read from the database.
    kept_local_mics: Vec<LocalMic>,
    /// The Stage-browser Local mics the active Stage last reported present.
    present_browser_mics: HashSet<String>,
    /// The Stage-browser Local mics whose device the active Stage last
    /// reported open: ready for a Calibration run (#210).
    capturing_browser_mics: HashSet<String>,
    /// The Local mics the active Stage last reported in digital silence
    /// (exact zeros for more than 2 s), for the seat warnings.
    silent_local_mics: HashSet<String>,
    /// Phones that reported their mic could not open. Kept while the
    /// server runs; a Phone reports again after a restart.
    blocked_phones: HashSet<PhoneId>,
    /// Phones that were in the Party and are out (a new Party started, or
    /// their Party member left or was removed) and have not joined since. A
    /// Phone asleep at the time hears [`ServerMessage::LeftParty`] in answer
    /// to its next Hello. Kept while the server runs.
    left_phones: HashSet<PhoneId>,
    /// The Mics with a Mic delay stored at the Stage output last reported
    /// (`None` until one is): a seated Mic not in it is "Not calibrated".
    /// Kept when the Stage closes, so the warnings do not flicker.
    calibrated_mics: Option<HashSet<MicKey>>,
    /// Mic bridges: approved (open or closed) and waiting for approval.
    bridges: bridges::Bridges,
    /// When each Song last started on the Stage (server time, ms), while
    /// the server runs: a Timing edit opened before that is not saved.
    last_started_ms: HashMap<SongId, i64>,
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
            refresh_computed(
                party,
                &HashSet::new(),
                &line_up::SeatMicState::default(),
                None,
            );
        }
        let bridges = bridges::Bridges::new(crate::mic_bridges::load(&db).await?);
        let kept_local_mics = crate::local_mics::all(&db).await?;
        let mut stages = HashMap::new();
        stages.insert(
            stage_id.clone(),
            Stage {
                party,
                last_local_mics,
                connection: None,
                output: None,
                progress: None,
                av_sync: false,
                av_sync_check: av_sync::AvSyncCheck::default(),
                calibration: None,
            },
        );
        Ok(Self {
            db,
            current_stage: stage_id,
            stages,
            hub: Hub::default(),
            mics: HashMap::new(),
            phones: HashMap::new(),
            songs,
            local_mics: Vec::new(),
            kept_local_mics,
            present_browser_mics: HashSet::new(),
            capturing_browser_mics: HashSet::new(),
            silent_local_mics: HashSet::new(),
            blocked_phones: HashSet::new(),
            left_phones: HashSet::new(),
            calibrated_mics: None,
            bridges,
            last_started_ms: HashMap::new(),
        }
        .with_local_mics())
    }

    /// `self` with its Local mic list made, before anyone connects.
    fn with_local_mics(mut self) -> Self {
        let list = self.local_mic_list();
        self.local_mics = local_mic_list::present_ids(&list);
        let blocked = self.blocked_phones.clone();
        let mut mics = self.seat_mic_state();
        mics.local_mics.clone_from(&list);
        let calibrated = self.calibrated_mics.clone();
        if let Some(party) = self.stage_mut().party.as_mut() {
            party.local_mics = list;
            refresh_computed(party, &blocked, &mics, calibrated.as_ref());
        }
        self
    }

    /// What the seat warnings about Local mics read now.
    fn seat_mic_state(&self) -> line_up::SeatMicState {
        let open: HashSet<&BridgeId> = self
            .bridges
            .open
            .values()
            .map(|open| &open.bridge_id)
            .collect();
        line_up::SeatMicState {
            local_mics: self
                .stage()
                .party
                .as_ref()
                .map(|party| party.local_mics.clone())
                .unwrap_or_default(),
            silent: self.silent_local_mics.clone(),
            closed_bridges: self
                .bridges
                .approved
                .iter()
                .filter(|approved| !open.contains(&approved.bridge_id))
                .map(|approved| (approved.bridge_id.clone(), approved.host_name.clone()))
                .collect(),
        }
    }

    /// The active Stage reports which Local mics deliver exact digital
    /// silence now (exact zeros for more than 2 s).
    fn report_silent_local_mics(
        &mut self,
        id: ConnectionId,
        local_mic_ids: Vec<String>,
    ) -> Result<(), UserMessage> {
        if self.stage().connection != Some(id) {
            return Err(UserMessage::NotTheStage);
        }
        let silent: HashSet<String> = local_mic_ids.into_iter().collect();
        if silent != self.silent_local_mics {
            self.silent_local_mics = silent;
            self.party_changed(ChangeEvent {
                actor: Actor::Stage,
                event: PartyEvent::LocalMicsChanged,
            });
        }
        Ok(())
    }

    /// The switched-on Local mics in Mics-screen order, with whether each
    /// is present now.
    fn local_mic_list(&self) -> Vec<PartyLocalMic> {
        let presence = local_mic_list::Presence {
            browser: self.present_browser_mics.clone(),
            bridge_channels: self.bridges.offered_local_mics(),
            bridges: self.bridges.approved_ids(),
        };
        local_mic_list::party_local_mics(&self.kept_local_mics, &presence)
    }

    /// Makes the Local mic list again after a Local mic, its presence or its
    /// bridge changed, and tells everyone the Party if the list changed.
    fn local_mics_changed(&mut self) {
        let list = self.local_mic_list();
        self.local_mics = local_mic_list::present_ids(&list);
        let Some(party) = self.stage_mut().party.as_mut() else {
            return;
        };
        if party.local_mics == list {
            return;
        }
        party.local_mics = list;
        self.party_changed(ChangeEvent {
            actor: Actor::Stage,
            event: PartyEvent::LocalMicsChanged,
        });
        // A bridge Local mic of a waiting Calibration is ready while present.
        self.refresh_calibration_ready();
    }

    /// Reads the kept Local mics again after the Stage wrote one.
    async fn reload_local_mics(&mut self) {
        match crate::local_mics::all(&self.db).await {
            Ok(kept) => self.kept_local_mics = kept,
            Err(error) => tracing::error!(?error, "reading Local mics"),
        }
        self.local_mics_changed();
    }

    /// The active Stage reports which of its own Local mics are present.
    fn report_present_local_mics(
        &mut self,
        id: ConnectionId,
        local_mic_ids: Vec<String>,
    ) -> Result<(), UserMessage> {
        if self.stage().connection != Some(id) {
            return Err(UserMessage::NotTheStage);
        }
        self.present_browser_mics = local_mic_ids.into_iter().collect();
        self.local_mics_changed();
        Ok(())
    }

    /// The active Stage reports which of its own Local mics capture now.
    fn report_capturing_local_mics(
        &mut self,
        id: ConnectionId,
        local_mic_ids: Vec<String>,
    ) -> Result<(), UserMessage> {
        if self.stage().connection != Some(id) {
            return Err(UserMessage::NotTheStage);
        }
        self.capturing_browser_mics = local_mic_ids.into_iter().collect();
        self.refresh_calibration_ready();
        Ok(())
    }

    /// Local mic `from` is now `to` (Find it, or a re-key): the waiting
    /// Line-up's seats and the Local mics members last sang on follow it.
    /// The database was changed with the relink.
    fn local_mic_relinked(&mut self, from: &str, to: &str) {
        let mut seat_moved = false;
        let stage = self.stage_mut();
        for local_mic_id in stage.last_local_mics.values_mut() {
            if local_mic_id == from {
                to.clone_into(local_mic_id);
            }
        }
        let seats = stage
            .party
            .as_mut()
            .and_then(|party| party.line_up.as_mut())
            .map(|line_up| line_up.seats.iter_mut());
        for seat in seats.into_iter().flatten() {
            if let Some(MicKey::LocalMic { local_mic_id }) = seat.mic.as_mut()
                && local_mic_id == from
            {
                to.clone_into(local_mic_id);
                seat_moved = true;
            }
        }
        if seat_moved {
            self.party_changed(ChangeEvent {
                actor: Actor::Stage,
                event: PartyEvent::LocalMicsChanged,
            });
        }
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
                        self.disconnect(id).await;
                    }
                }
                Command::Received {
                    id,
                    now_ms,
                    message,
                } => self.received(id, now_ms, message).await,
                Command::Disconnect { id } => self.disconnect(id).await,
                Command::SendAll { message } => self.hub.send_all(&message),
                Command::CreateProfile { new, now_ms, reply } => {
                    let _ = reply.send(self.create_profile(new, now_ms).await);
                }
                Command::EditProfile { id, edit, reply } => {
                    let _ = reply.send(self.edit_profile(id, edit).await);
                }
                Command::SongsLeft { songs } => self.songs_left(songs).await,
                Command::AutoFitAccepted {
                    phone_id,
                    song_id,
                    title,
                } => self.auto_fit_accepted(&phone_id, song_id, title),
                Command::SongPlaying { song_id, reply } => {
                    let _ = reply.send(self.song_playing(song_id));
                }
                Command::SongLastStarted { song_id, reply } => {
                    let _ = reply.send(self.last_started_ms.get(&song_id).copied());
                }
                Command::DeleteProfile { id, reply } => {
                    let _ = reply.send(self.delete_profile(id).await);
                }
                Command::ForgetBridge { bridge_id, reply } => {
                    let _ = reply.send(self.forget_bridge(bridge_id).await);
                }
                Command::MicBridges { reply } => {
                    let _ = reply.send(self.bridges.listing());
                }
                Command::FinishRound {
                    outcome,
                    now_ms,
                    reply,
                } => {
                    let _ = reply.send(self.finish_round(outcome, now_ms).await);
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
        let mut aborted = None;
        if role == Role::Bridge {
            self.bridges.sockets.insert(id);
        }
        if role == Role::Stage {
            if let Some(previous) = self.stage_mut().connection.replace(id) {
                self.hub.send_to(previous, &ServerMessage::StageMoved);
                // A takeover aborts the Song the old Stage was playing.
                aborted = self.abort_song().await;
            }
            // The new Stage reports its own output.
            self.stage_mut().output = None;
            self.av_sync_ended();
            self.calibration_ended();
            if self.stage().party.is_none() {
                started = self.start_party(now_ms).await;
            }
            // A Stage that moved takes its Mics screen with it, and its
            // Local mics until the new Stage reports its own.
            self.tell_mics_screen();
            self.present_browser_mics.clear();
            self.capturing_browser_mics.clear();
            self.silent_local_mics.clear();
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
        if let Some(progress) = self.current_progress(now_ms) {
            self.hub
                .send_to(id, &ServerMessage::SongProgress { progress });
        }
        self.tell_av_sync(id);
        self.tell_calibration_to(id);
        if let Some(change) = started.or(aborted) {
            self.party_changed(change);
        }
        if role == Role::Stage {
            self.local_mics_changed();
        }
        connection
    }

    async fn disconnect(&mut self, id: ConnectionId) {
        self.hub.remove(id);
        self.phones.remove(&id);
        if self.stage().connection == Some(id) {
            if let Some(change) = self.abort_song().await {
                self.party_changed(change);
            }
            let stage = self.stage_mut();
            stage.connection = None;
            stage.output = None;
            self.av_sync_ended();
            self.calibration_ended();
            self.tell_mics_screen();
            self.present_browser_mics.clear();
            self.capturing_browser_mics.clear();
            self.silent_local_mics.clear();
            self.local_mics_changed();
        }
        let closed: Vec<PhoneId> = self
            .mics
            .iter()
            .filter(|&(_, &connection)| connection == id)
            .map(|(phone_id, _)| phone_id.clone())
            .collect();
        for phone_id in closed {
            self.mics.remove(&phone_id);
            self.send_to_stage(&ServerMessage::MicClosed {
                mic: MicId::Phone { phone_id },
            });
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
                let left_phones: Vec<PhoneId> = self
                    .stage()
                    .party
                    .iter()
                    .flat_map(|party| party.phones.iter().map(|phone| phone.phone_id.clone()))
                    .collect();
                match self.start_party(now_ms).await {
                    Some(change) => {
                        self.left_phones.extend(left_phones);
                        // The run's Phones were the old Party's.
                        self.calibration_ended();
                        for connection in left {
                            self.hub.send_to(connection, &ServerMessage::LeftParty);
                        }
                        self.party_changed(change);
                    }
                    None => self.reject(id, UserMessage::ServerError),
                }
            }
            Ok(ClientMessage::PitchReading { reading, local_mic }) => {
                if let Some(mic) = self.sending_mic(id, local_mic.as_ref()) {
                    self.send_to_stage(&ServerMessage::PitchReading { mic, reading });
                }
            }
            Ok(ClientMessage::ClockPing { t0, local_mic }) => {
                if let Some(mic) = self.sending_mic(id, local_mic.as_ref()) {
                    self.send_to_stage(&ServerMessage::ClockPing { mic, t0 });
                }
            }
            Ok(ClientMessage::MicPage { visible }) => {
                if let Some(mic) = self.acting_mic(id) {
                    self.send_to_stage(&ServerMessage::MicPage { mic, visible });
                }
            }
            Ok(ClientMessage::ClockPong { mic, t0, ts, epoch }) => {
                if self.stage().connection != Some(id) {
                    self.reject(id, UserMessage::NotTheStage);
                    return;
                }
                // A pong for a Mic that has gone is dropped.
                match mic {
                    MicId::Phone { phone_id } => {
                        if let Some(&connection) = self.mics.get(&phone_id) {
                            self.hub.send_to(
                                connection,
                                &ServerMessage::ClockPong {
                                    t0,
                                    ts,
                                    epoch,
                                    local_mic: None,
                                },
                            );
                        }
                    }
                    MicId::Bridge {
                        bridge_id,
                        local_mic_id,
                    } => self.bridge_pong(&bridge_id, &local_mic_id, t0, ts, epoch),
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
                    local_mic_id.clone(),
                    new_local_mic_id.clone(),
                    source,
                );
                if self.refusable_mic_settings_write(id, relinked).await {
                    self.local_mic_relinked(&local_mic_id, &new_local_mic_id);
                }
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
            Ok(ClientMessage::StartAvSync) => {
                let result = self.start_av_sync(id);
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::StepAvSync { step }) => {
                let result = self.step_av_sync(id, step);
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::EndAvSync) => {
                let result = self.end_av_sync(id);
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::ReportAvSyncOffset { av_offset_ms }) => {
                let result = self.report_av_sync_offset(id, av_offset_ms);
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::OpenCalibration) => {
                let result = self.open_calibration(id);
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::OpenCalibrationFor { mic }) => {
                let result = self.open_calibration_for(id, mic);
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::ChooseCalibrationMic { mic, chosen }) => {
                let result = self.choose_calibration_mic(id, mic, chosen);
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::StartCalibration) => {
                let result = self.start_calibration(id);
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::CalibrationListening) => {
                let result = self.calibration_listening(id);
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::CalibrationGo) => {
                let result = self.calibration_go(id);
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::FinishCalibration { results }) => {
                let result = self.finish_calibration(id, results).await;
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::CalibrateLocalMicNow { local_mic_id }) => {
                let result = self.calibrate_local_mic_now(id, local_mic_id);
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::EndCalibration) => {
                let result = self.end_calibration(id);
                self.refuse_on_error(id, result);
            }
            Ok(ClientMessage::Hello { phone_id }) => {
                if !phone_id.is_valid() {
                    self.reject(id, UserMessage::InvalidMessage);
                    return;
                }
                self.phones.insert(id, phone_id);
                if self.joined_phone(id).is_none()
                    && self
                        .phones
                        .get(&id)
                        .is_some_and(|phone| self.left_phones.contains(phone))
                {
                    self.hub.send_to(id, &ServerMessage::LeftParty);
                } else {
                    self.send_phone_status(id);
                }
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
                let joined = self
                    .join(phone_id.clone(), &join_code, join_as, now_ms)
                    .await;
                if joined.is_ok() {
                    self.left_phones.remove(&phone_id);
                }
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
                // A Song that starts ends Check A/V sync and Calibrate mics.
                if control == SongControl::Start && controlled.is_ok() {
                    self.song_started(now_ms);
                    self.av_sync_ended();
                    self.calibration_ended();
                }
                self.refuse_on_error(id, controlled);
            }
            Ok(ClientMessage::ReportSongPosition {
                request_id,
                position_seconds,
                rate,
                length_seconds,
            }) => {
                let reported = self.report_song_position(
                    id,
                    now_ms,
                    SongProgress {
                        request_id,
                        position_seconds,
                        rate,
                        length_seconds,
                        age_ms: 0,
                    },
                );
                self.refuse_on_error(id, reported);
            }
            Ok(ClientMessage::ReportLineScore {
                request_id,
                seat,
                total,
            }) => {
                let reported = self.report_line_score(id, request_id, seat, total);
                self.refuse_on_error(id, reported);
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
            Ok(ClientMessage::ReportPresentLocalMics { local_mic_ids }) => {
                let reported = self.report_present_local_mics(id, local_mic_ids);
                self.refuse_on_error(id, reported);
            }
            Ok(ClientMessage::ReportCapturingLocalMics { local_mic_ids }) => {
                let reported = self.report_capturing_local_mics(id, local_mic_ids);
                self.refuse_on_error(id, reported);
            }
            Ok(ClientMessage::ReportSilentLocalMics { local_mic_ids }) => {
                let reported = self.report_silent_local_mics(id, local_mic_ids);
                self.refuse_on_error(id, reported);
            }
            Ok(ClientMessage::SetMicsScreenOpen { open }) => {
                self.set_mics_screen_open(id, open);
            }
            Ok(ClientMessage::BridgeLevels { levels }) => {
                self.bridge_levels(id, levels);
            }
            Ok(ClientMessage::BridgeInputDelays { delays }) => {
                self.bridge_input_delays(id, delays);
            }
            Ok(ClientMessage::ApproveBridge { request_id }) => {
                self.approve_bridge(id, request_id, now_ms).await;
            }
            Ok(ClientMessage::BridgeInterfaces {
                interfaces,
                not_pro_audio,
            }) => {
                self.bridge_interfaces(id, interfaces, not_pro_audio).await;
            }
            Ok(ClientMessage::SwitchBridgeToProAudio {
                bridge_id,
                device_name,
            }) => {
                self.switch_bridge_to_pro_audio(id, &bridge_id, device_name);
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
    /// Says whether it was written.
    async fn refusable_mic_settings_write(
        &mut self,
        id: ConnectionId,
        write: impl Future<Output = anyhow::Result<Result<(), UserMessage>>>,
    ) -> bool {
        if self.stage().connection != Some(id) {
            self.reject(id, UserMessage::NotTheStage);
            return false;
        }
        match write.await {
            Ok(Ok(())) => {
                self.hub.send_all(&ServerMessage::Changed {
                    topics: vec![ChangeTopic::MicSettings],
                });
                // A Calibration stored here may end a "Not calibrated".
                self.refresh_calibrated().await;
                // Open bridges show each channel's switch and name.
                self.send_bridge_channels(None).await;
                // The Line-up lists the switched-on Local mics by name.
                self.reload_local_mics().await;
                true
            }
            Ok(Err(refused)) => {
                self.reject(id, refused);
                false
            }
            Err(error) => {
                tracing::error!(?error, "storing Mic settings");
                self.reject(id, UserMessage::ServerError);
                false
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
        // Another output may hold other Mics' values.
        self.refresh_calibrated().await;
        Ok(())
    }

    /// Reads which Mics have a Mic delay stored at the Stage's current
    /// output, and tells everyone the Party when that changes the Line-up's
    /// "Not calibrated" warnings. With no output known it keeps the last.
    pub(super) async fn refresh_calibrated(&mut self) {
        let Some((output, _)) = self.stage().output.clone() else {
            return;
        };
        let stored = match crate::mic_settings::at_stage_output(&self.db, output.stage_output).await
        {
            Ok(stored) => stored,
            Err(error) => {
                tracing::error!(?error, "reading Mic settings");
                return;
            }
        };
        let calibrated: HashSet<MicKey> = stored
            .into_iter()
            .filter(|entry| entry.settings.calibration.is_some())
            .map(|entry| entry.mic)
            .collect();
        if self.calibrated_mics.as_ref() == Some(&calibrated) {
            return;
        }
        self.calibrated_mics = Some(calibrated);
        let waiting = self
            .stage()
            .party
            .as_ref()
            .is_some_and(|party| party.line_up.is_some());
        if waiting {
            self.party_changed(ChangeEvent {
                actor: Actor::Stage,
                event: PartyEvent::CalibrationChanged,
            });
        }
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

    /// The Mic a reading or ping from connection `id` is relayed as: one of
    /// an approved bridge's Local mics on a bridge socket (never a Phone),
    /// otherwise the Phone's ([`Self::acting_mic`]).
    fn sending_mic(
        &mut self,
        id: ConnectionId,
        local_mic: Option<&BridgeLocalMic>,
    ) -> Option<MicId> {
        if self.bridges.sockets.contains(&id) {
            self.bridge_mic(id, local_mic)
        } else {
            self.acting_mic(id)
        }
    }

    /// The Mic connection `id` sends readings and pings as: the Phone id it
    /// presented in `hello`, now that connection's Mic (a reconnect or a
    /// second tab of the same Phone takes it over). `None` for a connection
    /// that presented no Phone id: its readings and pings are dropped.
    fn acting_mic(&mut self, id: ConnectionId) -> Option<MicId> {
        let phone_id = self.phones.get(&id)?.clone();
        self.mics.insert(phone_id.clone(), id);
        Some(MicId::Phone { phone_id })
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
        // Change singers on the head whose Line-up waits: the Line-up is
        // prefilled again from the new requested Players (in `commit_queue`).
        if party.playing.is_none()
            && party.line_up.as_ref().map(|line_up| line_up.request_id) == Some(request_id)
        {
            party.line_up = None;
        }
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
            self.left_phones.insert(phone.clone());
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
        line_up::check(
            &mut line_up,
            &self.blocked_phones,
            &self.seat_mic_state(),
            self.calibrated_mics.as_ref(),
        );
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
        stage.progress = None;
        self.party_changed(ChangeEvent {
            actor,
            event: PartyEvent::SongStarted(change),
        });
        self.tell_stage(request_id, request.song_id, SongControl::Start);
        Ok(())
    }

    /// The active Stage dropped or was taken over: a Song it was playing is
    /// aborted, with no results and nothing stored (a late outcome for it is
    /// refused, see [`Self::finish_round`]). The Request stays at the head
    /// and its Line-up, fixed at Start, waits again as it was. Returns the
    /// change to tell everyone, if a Song played.
    async fn abort_song(&mut self) -> Option<ChangeEvent> {
        let playing = self.stage().party.as_ref()?.playing.clone()?;
        let request = queue::find(self.stage().party.as_ref()?, playing.request_id)
            .ok()?
            .clone();
        let change = self.request_change(&request).await;
        let blocked = self.blocked_phones.clone();
        let mics = self.seat_mic_state();
        let calibrated = self.calibrated_mics.clone();
        let stage = self.stage_mut();
        if let Some(party) = stage.party.as_mut() {
            party.playing = None;
            // A taking-over Stage hears the live state before the change:
            // it must say already that the Line-up can start again.
            refresh_computed(party, &blocked, &mics, calibrated.as_ref());
        }
        stage.progress = None;
        Some(ChangeEvent {
            actor: Actor::Stage,
            event: PartyEvent::SongAborted(change),
        })
    }

    /// The Stage's outcome of the Song that just ended (`POST /api/rounds`).
    ///
    /// - The outcome must be the current Party's. An outcome already stored
    ///   for its Request (the Stage retrying after a lost response) answers
    ///   what was stored, and changes nothing.
    /// - A skip is stored as it comes: Skip already moved the Party on.
    /// - A played or ended Song must still be playing (a Stage that dropped
    ///   or a server restart aborted it: nothing is stored), and its Scores
    ///   must be the seats of the Line-up fixed at Start, in seat order.
    ///   Then the round, its records, the results and the Queue without the
    ///   Request are stored in one transaction, and the Party shows the
    ///   results.
    async fn finish_round(
        &mut self,
        outcome: RoundOutcome,
        now_ms: i64,
    ) -> anyhow::Result<Result<RoundStored, scores::Refused>> {
        let Some(mut party) = self
            .stage()
            .party
            .clone()
            .filter(|party| party.party_id == outcome.party_id)
        else {
            return Ok(Err(scores::Refused::NotPlaying));
        };
        let request_id = outcome.request_id;
        let party_id = party.party_id.clone();
        if let Some(round) = self
            .db
            .call(move |conn| scores::round_for_request(conn, &party_id, request_id))
            .await?
        {
            let results = party
                .results
                .clone()
                .filter(|results| results.request_id == request_id);
            return Ok(Ok(RoundStored { round, results }));
        }
        let ended = match outcome.ended {
            RoundEnd::Skipped => {
                let stored = self
                    .db
                    .call(move |conn| {
                        let tx = conn.transaction()?;
                        let stored = scores::store_in(&tx, &outcome, now_ms)?;
                        if stored.is_ok() {
                            tx.commit()?;
                        }
                        Ok(stored)
                    })
                    .await?;
                return Ok(stored.map(|round| RoundStored {
                    round,
                    results: None,
                }));
            }
            RoundEnd::Played => SongEnd::Played,
            RoundEnd::Ended => SongEnd::Ended,
        };
        let Some(playing) = party
            .playing
            .clone()
            .filter(|playing| playing.request_id == request_id)
        else {
            return Ok(Err(scores::Refused::NotPlaying));
        };
        let Some(line_up) = party
            .line_up
            .clone()
            .filter(|line_up| line_up.request_id == request_id)
        else {
            return Ok(Err(scores::Refused::NotPlaying));
        };
        let Some(seated) = seated_players(&party, &line_up, &outcome) else {
            return Ok(Err(scores::Refused::Invalid));
        };
        if playing.song_id != outcome.song_id {
            return Ok(Err(scores::Refused::Invalid));
        }
        // `queue::remove` keeps the playing Request: it stops playing first.
        party.playing = None;
        let Ok(request) = queue::remove(&mut party, request_id) else {
            return Ok(Err(scores::Refused::NotPlaying));
        };
        let change = self.request_change(&request).await;
        party.head = None;
        party.line_up = None;
        let duet = line_up.duet;
        let song_id = playing.song_id;
        let stored = self
            .db
            .call(move |conn| {
                let tx = conn.transaction()?;
                let round = match scores::store_in(&tx, &outcome, now_ms)? {
                    Ok(round) => round,
                    Err(refused) => return Ok(Err(refused)),
                };
                let players = player_results(&tx, &round, &seated, duet)?;
                party.results = Some(SongResults {
                    request_id,
                    song_id,
                    ended,
                    players,
                });
                store::save_queue_in(&tx, &party)?;
                tx.commit()?;
                Ok(Ok((round, party)))
            })
            .await?;
        let (round, party) = match stored {
            Ok(stored) => stored,
            Err(refused) => return Ok(Err(refused)),
        };
        let results = party.results.clone();
        self.stage_mut().party = Some(party);
        self.party_changed(ChangeEvent {
            actor: Actor::Stage,
            event: PartyEvent::ResultsShown(change),
        });
        Ok(Ok(RoundStored { round, results }))
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

    /// Remembers when the Song that just started on the Stage started.
    fn song_started(&mut self, now_ms: i64) {
        let playing = self.stage().party.as_ref().and_then(|p| p.playing.as_ref());
        if let Some(song_id) = playing.map(|playing| playing.song_id) {
            self.last_started_ms.insert(song_id, now_ms);
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

    /// The active Stage reports where the playing Song stands (on start,
    /// pause, resume, Restart and end only): kept, and passed on to every
    /// connection as it is.
    fn report_song_position(
        &mut self,
        id: ConnectionId,
        now_ms: i64,
        progress: SongProgress,
    ) -> Result<(), UserMessage> {
        if self.stage().connection != Some(id) {
            return Err(UserMessage::NotTheStage);
        }
        let valid = |value: f64| value.is_finite() && value >= 0.0;
        if !valid(progress.position_seconds)
            || !valid(progress.rate)
            || !progress.length_seconds.is_none_or(valid)
        {
            return Err(UserMessage::InvalidMessage);
        }
        let plays = self
            .stage()
            .party
            .as_ref()
            .and_then(|party| party.playing.as_ref())
            .is_some_and(|playing| playing.request_id == progress.request_id);
        if !plays {
            return Err(UserMessage::NoSongPlaying);
        }
        self.hub.send_all(&ServerMessage::SongProgress {
            progress: progress.clone(),
        });
        self.stage_mut().progress = Some((progress, now_ms));
        Ok(())
    }

    /// Passes seat `seat`'s running total at a Line end to that seat's
    /// Phone alone: every connection that presented its Phone id.
    fn report_line_score(
        &mut self,
        id: ConnectionId,
        request_id: RequestId,
        seat: u32,
        total: u32,
    ) -> Result<(), UserMessage> {
        if self.stage().connection != Some(id) {
            return Err(UserMessage::NotTheStage);
        }
        let party = self.stage().party.as_ref();
        let plays = party
            .and_then(|party| party.playing.as_ref())
            .is_some_and(|playing| playing.request_id == request_id);
        if !plays {
            return Err(UserMessage::NoSongPlaying);
        }
        if total > MAX_TOTAL {
            return Err(UserMessage::InvalidMessage);
        }
        let seat = party
            .and_then(|party| party.line_up.as_ref())
            .and_then(|line_up| line_up.seats.get(seat as usize))
            .ok_or(UserMessage::InvalidMessage)?;
        let Some(MicKey::Phone { phone_id }) = &seat.mic else {
            return Ok(());
        };
        let phones: Vec<ConnectionId> = self
            .phones
            .iter()
            .filter(|(_, phone)| &phone.0 == phone_id)
            .map(|(&connection, _)| connection)
            .collect();
        for connection in phones {
            self.hub
                .send_to(connection, &ServerMessage::LineScore { request_id, total });
        }
        Ok(())
    }

    /// The latest position report, aged to `now_ms`, while its Request
    /// still plays.
    fn current_progress(&self, now_ms: i64) -> Option<SongProgress> {
        let stage = self.stage();
        let (progress, received_ms) = stage.progress.as_ref()?;
        let playing = stage.party.as_ref()?.playing.as_ref()?;
        if playing.request_id != progress.request_id {
            return None;
        }
        let age = now_ms
            .saturating_sub(*received_ms)
            .clamp(0, i64::from(u32::MAX));
        Some(SongProgress {
            age_ms: u32::try_from(age).unwrap_or(u32::MAX),
            ..progress.clone()
        })
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
    /// that has none yet (it just reached the head, or its requested
    /// Players were changed), and drops it when there is no head. A Line-up
    /// already waiting is kept as it is.
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
    /// A Phone's Auto-fit was saved: one change event, by that Phone's
    /// Party member (by the Admin area when the Phone is not joined), so the
    /// Stage shows the usual toast. Nothing happens without a Party.
    fn auto_fit_accepted(&mut self, phone_id: &PhoneId, song_id: SongId, title: String) {
        let member = self.stage().party.as_ref().and_then(|party| {
            party
                .phones
                .iter()
                .find(|phone| &phone.phone_id == phone_id)
                .map(|phone| phone.member_id)
        });
        let actor = member.map_or(Actor::Admin, |member_id| Actor::Member { member_id });
        self.party_changed(ChangeEvent {
            actor,
            event: PartyEvent::AutoFitAccepted { song_id, title },
        });
    }

    fn party_changed(&mut self, change: ChangeEvent) {
        let blocked = self.blocked_phones.clone();
        let mics = self.seat_mic_state();
        let calibrated = self.calibrated_mics.clone();
        let Some(party) = self.stage_mut().party.as_mut() else {
            return;
        };
        refresh_computed(party, &blocked, &mics, calibrated.as_ref());
        let party = party.clone();
        self.hub
            .send_all(&ServerMessage::PartyChanged { party, change });
        self.tell_bridges_detecting();
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

/// One seat of the Song that ended, with its member, as the results show it.
struct SeatedPlayer {
    member: PartyMember,
    mic: Option<MicKey>,
}

/// The seated Players of `line_up`, when the outcome's Scores are exactly
/// its seats in seat order: the same Profile or Guest, Voice and
/// Difficulty. `None` otherwise.
fn seated_players(
    party: &PartySnapshot,
    line_up: &LineUp,
    outcome: &RoundOutcome,
) -> Option<Vec<SeatedPlayer>> {
    if outcome.scores.len() != line_up.seats.len() {
        return None;
    }
    line_up
        .seats
        .iter()
        .zip(&outcome.scores)
        .map(|(seat, score)| {
            let member = party
                .members
                .iter()
                .find(|member| member.member_id == seat.member_id)?;
            let same_player = match (&member.identity, &score.player) {
                (Identity::Profile { profile_id }, ScorePlayer::Profile { profile_id: scored }) => {
                    profile_id == scored
                }
                (Identity::Guest { name, .. }, ScorePlayer::Guest { name: scored }) => {
                    name.trim() == scored.trim()
                }
                _ => false,
            };
            let voice = match seat.voice {
                SeatVoice::P1 => 0,
                SeatVoice::P2 => 1,
            };
            (same_player && score.voice == voice && score.difficulty == seat.difficulty).then(
                || SeatedPlayer {
                    member: member.clone(),
                    mic: seat.mic.clone(),
                },
            )
        })
        .collect()
}

/// Each seated Player's result from the stored round's records (in seat
/// order), ranked by total: place, Rank title band and the "new high
/// score" flag as stored. A Profile's name and avatar are read in `conn`.
fn player_results(
    conn: &rusqlite::Connection,
    round: &StoredRound,
    seated: &[SeatedPlayer],
    duet: bool,
) -> rusqlite::Result<Vec<PlayerResult>> {
    let totals: Vec<u32> = round.records.iter().map(|record| record.total).collect();
    let places = scores::places(&totals);
    let mut results = Vec::with_capacity(seated.len());
    for ((record, seat), place) in round.records.iter().zip(seated).zip(places) {
        let (name, avatar) = match &seat.member.identity {
            Identity::Guest { name, avatar, .. } => (name.clone(), *avatar),
            &Identity::Profile { profile_id } => {
                let profile = profiles::get_in(conn, profile_id)?
                    .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
                (profile.name, profile.avatar)
            }
        };
        results.push(PlayerResult {
            member_id: seat.member.member_id,
            player: record.player.clone(),
            name,
            avatar,
            colour: seat.member.colour,
            mic: seat.mic.clone(),
            voice: duet.then_some(record.voice),
            difficulty: record.difficulty,
            total: record.total,
            notes: record.notes,
            golden: record.golden,
            line_bonus: record.line_bonus,
            place,
            rank_title_band: scores::rank_title_band(record.total),
            new_high_score: record.new_high_score,
            mic_lost: record.mic_lost,
            unfinished: record.unfinished,
        });
    }
    // Ranked; equal totals keep their seat order.
    results.sort_by_key(|result| result.place);
    Ok(results)
}

/// Recomputes what the server derives in a snapshot: the Line-up's Start
/// availability and warnings, and which members are singing.
fn refresh_computed(
    party: &mut PartySnapshot,
    blocked_phones: &HashSet<PhoneId>,
    mics: &line_up::SeatMicState,
    calibrated: Option<&HashSet<MicKey>>,
) {
    let playing = party.playing.is_some();
    if let Some(line_up) = party.line_up.as_mut() {
        line_up::check(line_up, blocked_phones, mics, calibrated);
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

    /// Switched-on Stage-browser Local mics `ids`, reported present.
    fn plug_in(state: &mut LiveState, ids: &[&str]) {
        state.kept_local_mics = ids
            .iter()
            .map(|id| LocalMic {
                local_mic_id: (*id).to_owned(),
                source: LocalMicSource::Browser {
                    stage_browser: "stage".into(),
                    device_id: (*id).to_owned(),
                    label: (*id).to_owned(),
                    channel: 0,
                    stereo: false,
                },
                name: String::new(),
                switched_on: true,
            })
            .collect();
        state.present_browser_mics = ids.iter().map(|id| (*id).to_owned()).collect();
        state.local_mics_changed();
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
        let stage = state.connect(Role::Stage, 3).await;
        plug_in(&mut state, &["red", "blue"]);
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
        let stage = state.connect(Role::Stage, 1).await;
        plug_in(&mut state, &["red"]);
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
        state.disconnect(stage.id).await;
        drain(&mut phone);
        state.send_to_stage(&ServerMessage::Pong { nonce: 5 });
        assert_eq!(drain(&mut phone), vec![]);
    }
}
