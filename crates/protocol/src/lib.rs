//! The single source of every HTTP body and WebSocket message.
//!
//! Each type derives `ts_rs::TS` with `#[ts(export)]`; running this crate's
//! tests writes the TypeScript types to `web/src/generated/`, which is
//! committed. `just check` fails when the committed files drift.

pub mod admin;
pub mod av_offset;
pub mod bridge;
pub mod jobs;
pub mod library;
pub mod mics;
pub mod party;
pub mod pitch;
pub mod pitch_track;
pub mod profile;
pub mod scoring;
pub mod song;
pub mod stage_options;
pub mod usdb;
pub mod volume;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use party::{
    Actor, ChangeEvent, Identity, JoinAs, JoinCode, JoinedPhone, LineUp, LineUpEdit, LineUpWarning,
    MemberEdit, NewGuest, PartyEvent, PartyId, PartyMember, PartyMemberId, PartySnapshot, PhoneId,
    PlayingSong, QueueMove, Request, RequestChange, RequestId, RequestKind, SEATS, Seat, SeatVoice,
    SeatWho, SongControl, SongEnd, SongProgress, SongResults,
};
pub use pitch::{BridgeLocalMic, MicId, PitchReading};
pub use scoring::BeatValue;

/// Body of `GET /api/server-info`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServerInfo {
    /// The build identifier of the running server.
    pub version: String,
    /// The schema version of the database after startup migrations.
    pub schema_version: u32,
    /// Why the Library is read-only, or `null` when it can be written to.
    pub library_read_only: Option<LibraryReadOnly>,
    /// `OPENSTAR_PUBLIC_URL`, or `null` when it is not set: then the join
    /// address is the address the Stage was opened on.
    pub public_url: Option<String>,
}

/// Why the Library is read-only: a code plus its parameters. The frontend
/// turns it into the notice text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryReadOnly {
    pub code: LibraryReadOnlyCode,
    /// The songs folder, as the server sees it (`/songs` in the image).
    pub songs_dir: String,
}

/// Why the Library is read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LibraryReadOnlyCode {
    /// The songs folder cannot be written to, for example because it is mounted `:ro`.
    SongsFolderNotWritable,
    /// The songs folder does not exist.
    SongsFolderMissing,
}

/// Names one Stage. Live state on the server is keyed by it, so more than one
/// Stage stays a code change; v1 has exactly one Stage id in use.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StageId(pub String);

/// A message a browser sends over its WebSocket.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ClientMessage {
    /// Asks the server to answer with a [`ServerMessage::Pong`] carrying the same nonce.
    Ping { nonce: u32 },
    /// Starts a new Party with a new Join code. Accepted only from the
    /// active Stage; needs no Admin PIN.
    NewParty,
    /// One Pitch reading from this browser's Mic, or from one Local mic of
    /// an approved Mic bridge, relayed to the current Stage (dropped while
    /// there is none).
    PitchReading {
        reading: PitchReading,
        /// Only from a Mic bridge, which must say which of its Local mics
        /// the reading is from; a Phone leaves it out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        local_mic: Option<BridgeLocalMic>,
    },
    /// A clock-sync ping, relayed to the current Stage (dropped while there
    /// is none). `t0` is the send time on the sender's own clock, in ms.
    ClockPing {
        t0: f64,
        /// Only from a Mic bridge: the Local mic that syncs (each syncs on
        /// its own); a Phone leaves it out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        local_mic: Option<BridgeLocalMic>,
    },
    /// The Stage's answer to a [`ServerMessage::ClockPing`], relayed to the
    /// Mic named in `mic` alone. Accepted only from the active Stage.
    ClockPong {
        mic: MicId,
        /// The ping's `t0`, unchanged.
        t0: f64,
        /// The Stage page's `performance.now()` when it answered, in ms.
        ts: f64,
        /// The Stage page's `performance.timeOrigin`, in ms since the Unix
        /// epoch: a new value means the Stage's clock is a new one.
        epoch: f64,
    },
    /// This Phone's page was hidden (its mic is lost: it stops sending
    /// readings) or is visible again, relayed to the current Stage as a
    /// [`ServerMessage::MicPage`] (dropped while there is none).
    MicPage { visible: bool },
    /// Sets a Phone's Mic threshold by hand at `stage_output`, in dBFS at the
    /// reference volume: from the active Stage for any Phone (a Line-up
    /// seat's meter), or from a Phone for its own (the Phone id its
    /// connection presented) at the Stage's current output. Refused with
    /// [`UserMessage::NotTheStage`] for another Phone's, and with
    /// [`UserMessage::NoStage`] from a Phone when `stage_output` is not the
    /// Stage's current output. Needs no Admin PIN. Every browser gets
    /// [`ChangeTopic::MicSettings`].
    SetPhoneMicThreshold {
        stage_output: String,
        phone_id: PhoneId,
        reference_dbfs: f64,
    },
    /// A Phone's mic diagnostics ask what the Stage receives from it, about
    /// once a second while they are open: relayed to the current Stage as
    /// [`ServerMessage::MicReportRequest`] (dropped while there is none).
    MicReportRequest,
    /// The Stage's answer to a [`ServerMessage::MicReportRequest`], relayed
    /// to that Phone alone as [`ServerMessage::MicReport`]. Refused with
    /// [`UserMessage::NotTheStage`] from anyone but the active Stage.
    MicReport {
        mic: MicId,
        report: pitch::StageMicReport,
    },
    /// Stores a Calibration run's successful results at `stage_output`, one
    /// per Mic included; a Mic left out keeps every value it had. Accepted
    /// only from the active Stage; needs no Admin PIN.
    StoreCalibration {
        stage_output: String,
        results: Vec<mics::CalibrationResult>,
    },
    /// Sets a Local mic's Mic threshold by hand at `stage_output`, in dBFS at
    /// the reference volume. Accepted only from the active Stage; needs no
    /// Admin PIN.
    SetMicThreshold {
        stage_output: String,
        local_mic_id: String,
        reference_dbfs: f64,
    },
    /// Switches a Local mic on or off, keeping it (with an empty name if it
    /// is new) and its `source` as last seen. Accepted only from the active
    /// Stage; needs no Admin PIN. Every browser gets
    /// [`ChangeTopic::MicSettings`].
    SetLocalMicSwitchedOn {
        local_mic_id: String,
        source: mics::LocalMicSource,
        switched_on: bool,
    },
    /// Names a Local mic (surrounding spaces trimmed; an empty name is kept
    /// empty and shown with its default), keeping it with its `source` as
    /// last seen and, if it is new, switched off. Accepted only from the
    /// active Stage; needs no Admin PIN. Every browser gets
    /// [`ChangeTopic::MicSettings`].
    SetLocalMicName {
        local_mic_id: String,
        source: mics::LocalMicSource,
        name: String,
    },
    /// Find it, and the Stage's automatic re-key: the channel
    /// `new_local_mic_id` (at `source`), which is not yet a Local mic, takes
    /// over Local mic `local_mic_id`: its name, whether it is switched on and
    /// every Mic setting stored against it at every Stage output. The old id
    /// is gone afterwards. Refused with [`UserMessage::LocalMicNotFound`] or
    /// [`UserMessage::ChannelAlreadyLocalMic`]. Accepted only from the active
    /// Stage; needs no Admin PIN. Every browser gets
    /// [`ChangeTopic::MicSettings`].
    RelinkLocalMic {
        local_mic_id: String,
        new_local_mic_id: String,
        source: mics::LocalMicSource,
    },
    /// The Stage reports its current Stage output: its Stage browser id and
    /// the output key (the default `audiooutput` label without "Default - ").
    /// Sent whenever it becomes the Stage and whenever the output changes.
    /// The server switches to that output's stored OpenStar volume (80 when
    /// none is stored) and sends every connection a
    /// [`ServerMessage::Volume`]. Accepted only from the active Stage; needs
    /// no Admin PIN.
    ReportStageOutput {
        stage_browser: String,
        stage_output: String,
    },
    /// Turns the OpenStar volume one step up or down, from the Stage or any
    /// Remote, with no Admin PIN. The server stores it at the Stage's
    /// current output and sends every connection a [`ServerMessage::Volume`].
    /// Refused with [`UserMessage::NotInParty`] for a Phone that has not
    /// joined, and [`UserMessage::NoStage`] while no Stage has reported its
    /// output.
    StepVolume { step: volume::VolumeStep },
    /// Starts Check A/V sync on the Stage, from the Stage (its Setup pill) or
    /// any joined Remote, with no Admin PIN. Every connection is told
    /// [`ServerMessage::AvSync`]. Refused with [`UserMessage::NotInParty`]
    /// for a Phone that has not joined, [`UserMessage::NoStage`] with no
    /// Stage open, and [`UserMessage::NotWhileSongPlays`] while a Song plays.
    /// Starting it while it runs changes nothing.
    StartAvSync,
    /// One press during Check A/V sync from a Remote: relayed to the Stage
    /// as [`ServerMessage::StepAvSync`], which saves the new value under its
    /// own browser id. Refused with [`UserMessage::AvSyncNotRunning`] while
    /// the check does not run, and [`UserMessage::NotInParty`] for a Phone
    /// that has not joined.
    StepAvSync { step: av_offset::AvSyncStep },
    /// Done: ends Check A/V sync, from the Stage or any joined Remote. Every
    /// connection is told [`ServerMessage::AvSync`]. Ending it when it does
    /// not run changes nothing. It also ends when the Stage closes, another
    /// browser becomes the Stage, or a Song starts.
    EndAvSync,
    /// The active Stage's A/V offset while Check A/V sync runs, so every
    /// Remote shows it large: sent when the check opens and after every
    /// change. Every connection is told [`ServerMessage::AvSyncCheck`].
    /// Refused with [`UserMessage::NotTheStage`] from anyone but the active
    /// Stage, [`UserMessage::AvSyncNotRunning`] while the check does not
    /// run, and [`UserMessage::InvalidMessage`] for a value off the A/V
    /// offset's range or 10 ms grid.
    ReportAvSyncOffset { av_offset_ms: i32 },
    /// Calibrate mics (#170), from the Stage's Setup pill (or any joined
    /// Remote), with no Admin PIN: opens the run's checklist with every
    /// joined Phone ticked. Every connection is told
    /// [`ServerMessage::Calibration`]. Refused with
    /// [`UserMessage::NotWhileSongPlays`] while a Song plays,
    /// [`UserMessage::AvSyncRunning`] during Check A/V sync and
    /// [`UserMessage::NoStage`] with no Stage open. Opening it while a run
    /// is open changes nothing.
    OpenCalibration,
    /// Calibrate mics from a "Not calibrated" seat (#171): like
    /// [`ClientMessage::OpenCalibration`], with `mic` also ticked (added to
    /// the checklist when it does not list it). On a checklist already open
    /// it ticks `mic`; once the run is past the checklist it changes
    /// nothing. Refused like [`ClientMessage::OpenCalibration`].
    OpenCalibrationFor { mic: mics::MicKey },
    /// Ticks or unticks a Mic on the open checklist. Refused with
    /// [`UserMessage::CalibrationNotRunning`] outside the checklist and
    /// [`UserMessage::InvalidMessage`] for a Mic it does not list.
    ChooseCalibrationMic { mic: mics::MicKey, chosen: bool },
    /// Continue on the checklist: asks every chosen Mic to listen. Refused
    /// with [`UserMessage::NoMicsChosen`] when nothing is ticked and
    /// [`UserMessage::NoStage`] while the Stage has reported no output (the
    /// results are stored against the output in effect now).
    StartCalibration,
    /// "I'm listening", from a chosen Phone: its Mic is ready. When every
    /// chosen Mic is ready the tones start. Refused with
    /// [`UserMessage::NotInCalibration`] for a Phone that is not chosen and
    /// [`UserMessage::CalibrationNotRunning`] unless the run waits.
    CalibrationListening,
    /// Go: the tones start now; chosen Mics not ready take no part. Refused
    /// with [`UserMessage::NoMicReady`] while no Mic is ready.
    CalibrationGo,
    /// Stage only: the analysis after the tones. `results` (successes) are
    /// stored against the Stage output of [`ClientMessage::StartCalibration`];
    /// every other Mic in the run failed and keeps its values. Refused with
    /// [`UserMessage::CalibrationNotRunning`] unless the tones play.
    FinishCalibration {
        results: Vec<mics::CalibrationResult>,
    },
    /// "Calibrate this mic now" (#210), offered when a Local mic is switched
    /// on: the normal run with that Local mic as the only chosen Mic, past
    /// the checklist (as if Continue was pressed). Refused like
    /// [`ClientMessage::OpenCalibration`], with
    /// [`UserMessage::CalibrationRunning`] while a run is open and
    /// [`UserMessage::InvalidMessage`] for a Local mic not switched on.
    CalibrateLocalMicNow { local_mic_id: String },
    /// Cancel or Done: closes the run, from the Stage or any joined Remote;
    /// nothing more is stored. It also ends when the Stage closes or moves,
    /// a Song starts, or a new Party starts.
    EndCalibration,
    /// Presents the browser's Phone id. A Phone sends it every time its
    /// WebSocket opens, before anything else. A Phone already in the current
    /// Party is back in at once with the same identity (silent rejoin). The
    /// answer is a [`ServerMessage::PhoneStatus`], or
    /// [`ServerMessage::LeftParty`] for a Phone that was in the Party and is
    /// out (it may have been asleep when it left) and has not joined since.
    Hello { phone_id: PhoneId },
    /// Asks whether this is the current Party's Join code, before the Phone
    /// picks who it is. Answered with [`ServerMessage::JoinCodeValid`], or
    /// refused with [`UserMessage::JoinCodeWrong`]. Wrong codes are never
    /// counted or delayed.
    CheckJoinCode { join_code: JoinCode },
    /// Joins the current Party: the Join code plus an identity. Presents the
    /// Phone id like [`ClientMessage::Hello`]. A Phone already in the Party
    /// that joins again switches to the new identity.
    Join {
        phone_id: PhoneId,
        join_code: JoinCode,
        join_as: JoinAs,
    },
    /// Switches the identity of this connection's Phone, which has joined
    /// the Party: no Join code needed. Only what this Phone uses changes;
    /// the previous identity stays a Party member with its colour. Refused
    /// with [`UserMessage::NotInParty`] for a Phone that has not joined.
    SwitchIdentity { join_as: JoinAs },
    /// Changes a Party member's name, avatar or colour inside the Party (see
    /// [`MemberEdit`]). A Remote command.
    EditMember {
        member_id: PartyMemberId,
        edit: MemberEdit,
    },
    /// Adds a Request for a Library Song at the end of the Queue. From a
    /// Phone, `requested_players` defaults to the Phone's Party member when
    /// `null`; the Stage names none. A Remote command (Stage or joined Phone).
    AddRequest {
        song_id: library::SongId,
        requested_players: Option<Vec<PartyMemberId>>,
    },
    /// Moves a Request one place up or down, or to directly after the head.
    /// A Remote command.
    MoveRequest {
        request_id: RequestId,
        to: QueueMove,
    },
    /// Replaces a Request's requested Players. A Remote command.
    SetRequestedPlayers {
        request_id: RequestId,
        requested_players: Vec<PartyMemberId>,
    },
    /// Removes a Request from the Queue, the head included. A Remote command.
    RemoveRequest { request_id: RequestId },
    /// A joined Phone reports whether its mic could not open (`blocked`) or
    /// has opened (`blocked: false`, which clears the report). A seated
    /// Phone's report shows as "<name>'s mic is blocked"; it never blocks
    /// Start. Kept only while the server runs: a Phone reports again after
    /// a restart.
    ReportMicBlocked { blocked: bool },
    /// This connection's joined Phone leaves the Party ("Leave party"): its
    /// Party member leaves (see [`ClientMessage::RemoveMember`]). Refused
    /// with [`UserMessage::NotInParty`] for anyone but a joined Phone.
    LeaveParty,
    /// Removes a Party member from the Party people list (a Remote command,
    /// no Admin PIN). Its colour is free at once, every Phone using it is
    /// out of the Party (told with [`ServerMessage::LeftParty`]) and it is
    /// dropped from every Request. A Guest is gone; a Profile may enter
    /// again. Refused while the member sits in the Line-up
    /// ([`UserMessage::MemberSinging`]), and for a Phone's own member
    /// ([`UserMessage::UseLeaveParty`]).
    RemoveMember { member_id: PartyMemberId },
    /// Edits the waiting Line-up of Request `request_id` (see
    /// [`LineUpEdit`]). A Remote command; refused with
    /// [`UserMessage::LineUpNotWaiting`] when that Request's Line-up is not
    /// the one waiting.
    EditLineUp {
        request_id: RequestId,
        edit: LineUpEdit,
    },
    /// "My Difficulty for the next Song" from a joined Phone: sets the
    /// Difficulty of its member's seat when seated, otherwise the Difficulty
    /// its next seat starts at (a Guest's Party Difficulty, a Profile's last
    /// Difficulty). Refused with [`UserMessage::NotInParty`] for anyone but
    /// a joined Phone.
    SetMyDifficulty { difficulty: profile::Difficulty },
    /// Start, Pause, Resume, Restart, End or Skip for the head's Song,
    /// `request_id` (a Remote command). Accepted ones are passed to the
    /// Stage. Start is refused with [`UserMessage::LineUpNotWaiting`] when
    /// that Request's Line-up is not waiting, [`UserMessage::LineUpNotReady`]
    /// when it cannot start, and [`UserMessage::NoStage`] with no Stage
    /// open; the others with [`UserMessage::NoSongPlaying`] when that
    /// Request's Song is not playing. Pause on a paused Song and Resume on a
    /// running one change nothing.
    ControlSong {
        request_id: RequestId,
        control: SongControl,
    },
    /// The active Stage reports where the playing Song stands, only on
    /// events: when it starts, pauses, resumes (once it really plays after
    /// the countdown), restarts (Restart, the only seek) and ends. `rate` is
    /// 1 while it plays and 0 while it is paused or after its end. The
    /// server keeps the latest report and passes it to every connection as
    /// [`ServerMessage::SongProgress`]. Refused with
    /// [`UserMessage::NotTheStage`] from anyone but the active Stage, with
    /// [`UserMessage::NoSongPlaying`] when Request `request_id` is not
    /// playing, and with [`UserMessage::InvalidMessage`] for a position,
    /// rate or length that is negative or not finite.
    ReportSongPosition {
        request_id: RequestId,
        position_seconds: f64,
        rate: f64,
        length_seconds: Option<f64>,
    },
    /// The active Stage reports, at the end of a Line, the running total of
    /// seat `seat` (its index in the Line-up fixed at Start) of the playing
    /// Request `request_id`. The server passes it only to that seat's Phone,
    /// as [`ServerMessage::LineScore`] (a seat with a Local mic or no Mic
    /// has no Phone to tell). Refused with [`UserMessage::NotTheStage`] from
    /// anyone but the active Stage, with [`UserMessage::NoSongPlaying`] when
    /// Request `request_id` is not playing, and with
    /// [`UserMessage::InvalidMessage`] for a seat the Line-up does not have
    /// or a total over 10000.
    ReportLineScore {
        request_id: RequestId,
        seat: u32,
        total: u32,
    },
    /// Next (or Done, with an empty Queue) on the results: the next
    /// Request's Line-up comes up prefilled, or the song browser. A Remote
    /// command; [`UserMessage::NoResults`] when no results show.
    CloseResults,
    /// A Mic bridge asks to join, first thing on its own WebSocket
    /// (`/ws/bridge`; refused with [`UserMessage::NotABridge`] anywhere
    /// else). With a valid approval `token` it is connected at once
    /// ([`ServerMessage::BridgeConnected`]); otherwise it waits for approval
    /// ([`ServerMessage::BridgeWaiting`]). Sending it again replaces what
    /// the bridge offers.
    BridgeHello {
        /// The bridge's build identifier (`X.Y.Z`, `edge-<sha>` or `dev`).
        build: String,
        /// The name of the bridge's computer.
        host_name: String,
        /// The approval token it keeps, if any.
        token: Option<String>,
        /// Every interface it reads, each with its hardware channels.
        interfaces: Vec<bridge::BridgeInterface>,
    },
    /// From a Mic bridge right after its hello, and whenever what it sees
    /// changes (a profile changed, however it was changed; an interface
    /// came or went; a Switch to Pro Audio was refused): every interface it
    /// reads and every one not in Pro Audio, replacing what it said before.
    /// Dropped from any socket that is not a bridge's.
    BridgeInterfaces {
        interfaces: Vec<bridge::BridgeInterface>,
        not_pro_audio: Vec<bridge::NotProAudio>,
    },
    /// Switch to Pro Audio on the Stage's Mics screen: the server asks open
    /// bridge `bridge_id` to switch its interface `device_name` to the Pro
    /// Audio profile ([`ServerMessage::BridgeSwitchProfile`]). Accepted only
    /// from the active Stage; no Admin PIN (it changes no kept data).
    /// [`UserMessage::BridgeNotFound`] when that bridge is not open.
    SwitchBridgeToProAudio {
        bridge_id: bridge::BridgeId,
        device_name: String,
    },
    /// Approves a Mic bridge waiting for approval. Accepted only from the
    /// active Stage; needs no Admin PIN (becoming the Stage needed it).
    /// [`UserMessage::BridgeRequestNotFound`] when no bridge waits under
    /// that id.
    ApproveBridge { request_id: bridge::BridgeRequestId },
    /// The Stage's Mics screen opened (`true`) or closed. Accepted only from
    /// the active Stage; the server tells every open Mic bridge
    /// ([`ServerMessage::BridgeMicsScreen`]). It counts as closed once that
    /// Stage closes or another browser becomes the Stage.
    SetMicsScreenOpen { open: bool },
    /// From the active Stage, whenever it changes and on every connect:
    /// which of its own Local mics are present now (their device plugged in
    /// and listed). Replaces the last report; the server lists them in the
    /// Party snapshot and offers the switched-on ones to the Line-up.
    /// Gone when that Stage closes or another browser becomes the Stage.
    ReportPresentLocalMics { local_mic_ids: Vec<String> },
    /// From the active Stage, whenever it changes and on every connect:
    /// which of its own Local mics have their capture running now (their
    /// device open). Replaces the last report; a chosen Stage-browser Local
    /// mic of a Calibration run is ready while listed (#210). Gone when
    /// that Stage closes or another browser becomes the Stage.
    ReportCapturingLocalMics { local_mic_ids: Vec<String> },
    /// From the active Stage, whenever it changes: which switched-on Local
    /// mics (its own or a Mic bridge's) delivered exact digital silence,
    /// every sample zero, for more than 2 s. Replaces the last report; the
    /// server shows it as a seat warning. Gone when that Stage closes or
    /// another browser becomes the Stage.
    ReportSilentLocalMics { local_mic_ids: Vec<String> },
    /// From an open (approved, connected) Mic bridge, ten times a second:
    /// the meter level of each channel it meters. Relayed to the Stage as
    /// [`ServerMessage::LocalMicLevels`]; dropped from any other socket and
    /// for channels the bridge does not offer.
    BridgeLevels { levels: Vec<bridge::BridgeLevel> },
    /// From an open Mic bridge, whenever its capture backend reports them
    /// (never in `--wav` mode): the input delay of each listed hardware
    /// channel. Replaces what it reported before for those channels; listed
    /// in `GET /api/mic-bridges` as each channel's reported input delay.
    /// Dropped from any other socket and for channels the bridge does not
    /// offer.
    BridgeInputDelays {
        delays: Vec<bridge::BridgeInputDelay>,
    },
}

/// A message the server sends over a WebSocket.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ServerMessage {
    /// The answer to a [`ClientMessage::Ping`].
    Pong { nonce: u32 },
    /// The server could not act on a message the browser sent.
    Rejected { reason: UserMessage },
    /// The whole live state of the browser's Stage. The first message on
    /// every connection, so a browser that reconnects is told the state again.
    LiveState {
        stage_id: StageId,
        /// The current Party, or `null` before the first Stage has opened on
        /// a fresh server.
        party: Option<PartySnapshot>,
        /// Whether this connection is the active Stage.
        is_stage: bool,
    },
    /// An accepted change to the Party (sent to every connection): the whole
    /// Party after it, plus what changed and who changed it.
    PartyChanged {
        party: PartySnapshot,
        change: ChangeEvent,
    },
    /// Sent to the Stage when another browser became the Stage. This
    /// connection is no longer the Stage; the Party carries on unchanged.
    StageMoved,
    /// HTTP data changed: the frontend refetches what each topic names.
    Changed { topics: Vec<ChangeTopic> },
    /// Stage only: a Pitch reading from a Mic, values unchanged.
    PitchReading { mic: MicId, reading: PitchReading },
    /// Stage only: a Mic's clock-sync ping. Answer at once with a
    /// [`ClientMessage::ClockPong`] naming the same Mic.
    ClockPing { mic: MicId, t0: f64 },
    /// The Stage's answer to this browser's (or bridge's)
    /// [`ClientMessage::ClockPing`].
    ClockPong {
        t0: f64,
        ts: f64,
        epoch: f64,
        /// To a Mic bridge only: the Local mic whose ping this answers.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        local_mic: Option<BridgeLocalMic>,
    },
    /// Stage only: a Mic's WebSocket closed (one of the lost-Mic signals).
    MicClosed { mic: MicId },
    /// Stage only: a Phone's page was hidden or is visible again (the
    /// lost-Mic signals `pageHidden` and `pageVisible`).
    MicPage { mic: MicId, visible: bool },
    /// Stage only: a Phone's mic diagnostics ask what the Stage receives
    /// from it. Answer with a [`ClientMessage::MicReport`] naming the same
    /// Mic.
    MicReportRequest { mic: MicId },
    /// The Stage's answer to this Phone's [`ClientMessage::MicReportRequest`].
    MicReport { report: pitch::StageMicReport },
    /// The answer to a [`ClientMessage::CheckJoinCode`] with the current code.
    JoinCodeValid { join_code: JoinCode },
    /// Sent to a connection after its [`ClientMessage::Hello`] or accepted
    /// [`ClientMessage::Join`]: the Party member its Phone uses now, or `null`
    /// when its Phone is not in the current Party and must join with the code.
    PhoneStatus { member_id: Option<PartyMemberId> },
    /// Sent to every connection of a Phone that was in the Party and no
    /// longer is (a new Party started, or its Party member left or was
    /// removed): it needs the Join code to come back. A Phone that was not
    /// connected then hears it in answer to its next
    /// [`ClientMessage::Hello`].
    LeftParty,
    /// The Stage's current OpenStar volume (0 to 100), sent to every
    /// connection when the Stage reports its output and on every step, and to
    /// a new connection after its [`ServerMessage::LiveState`] while a Stage
    /// has reported its output. `stepped` is true when a
    /// [`ClientMessage::StepVolume`] changed it (the Stage shows its volume
    /// pill then), false when the output changed or a browser connected.
    Volume {
        volume: u8,
        stepped: bool,
        /// The Stage output the volume belongs to (its output key): a Phone
        /// reads its own Mic settings at it. Always sent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        stage_output: Option<String>,
    },
    /// Whether Check A/V sync runs on the Stage, sent to every connection
    /// when it starts and ends, and to a new connection after its
    /// [`ServerMessage::LiveState`] while it runs. A Remote shows its big
    /// −/+ and Done while it runs.
    AvSync { running: bool },
    /// Stage only: a Remote's press during Check A/V sync (see
    /// [`ClientMessage::StepAvSync`]).
    StepAvSync { step: av_offset::AvSyncStep },
    /// What is known about the running Check A/V sync, sent to every
    /// connection after [`ServerMessage::AvSync`] when a Phone starts it and
    /// whenever the Stage reports its value, and to a new connection after
    /// `AvSync` while it runs and something is known. `started_by` is the
    /// Phone that started it (`None` for the Stage), which shows the −/+
    /// and Done as its page; `av_offset_ms` is the Stage's A/V offset, once
    /// the Stage has reported it. Both are `None` again on the next check.
    AvSyncCheck {
        started_by: Option<PhoneId>,
        av_offset_ms: Option<i32>,
    },
    /// The Calibration run, or `None` when it ended, sent to every
    /// connection on every change, and to a new connection after its
    /// [`ServerMessage::LiveState`] while one is open.
    Calibration { run: Option<mics::CalibrationRun> },
    /// A background job was queued, started, made progress or ended (sent to
    /// every connection).
    JobChanged { job: jobs::Job },
    /// Stage only: act on the head's Song (Request `request_id`, Song
    /// `song_id`), after the server accepted `control` from the Stage or a
    /// Remote. Sent after the [`ServerMessage::PartyChanged`] that reports
    /// it. On Start the seats are the snapshot's `lineUp`, fixed for the
    /// Song.
    ControlSong {
        request_id: RequestId,
        song_id: library::SongId,
        control: SongControl,
    },
    /// The Stage's latest position report for the playing Song (see
    /// [`ClientMessage::ReportSongPosition`]), sent to every connection
    /// when the Stage reports, and to a new connection after its
    /// [`ServerMessage::LiveState`] while a Song plays. Never sent
    /// continuously. A report whose Request no longer plays is stale.
    SongProgress { progress: SongProgress },
    /// To a seat's Phone alone: that seat's running total at its latest
    /// Line end in the playing Request `request_id`, as the Stage's scorer
    /// reported it ([`ClientMessage::ReportLineScore`]). The mic takeover's
    /// Score; never sent continuously. A Phone back after a reload or a
    /// drop hears the last one again right after its
    /// [`ServerMessage::PhoneStatus`], while that Request plays.
    LineScore { request_id: RequestId, total: u32 },
    /// To a Mic bridge whose hello named another build than the server's
    /// (newer or older): the server's `build`. The bridge is neither
    /// connected nor asked to wait for approval; it updates itself to this
    /// build from `/bridge/openstar-mic-bridge` and says hello again. Kept
    /// this small on purpose: every build must read it.
    BridgeUpdate { build: String },
    /// To a Mic bridge without a valid token: it waits for approval on the
    /// Stage, which shows the same 4-digit `code`.
    BridgeWaiting { code: String },
    /// To a Mic bridge the Stage just approved: its approval token, sent
    /// this once. The bridge keeps it and presents it from then on.
    BridgeApproved { token: String },
    /// To a Mic bridge: it is approved and connected, as `bridge_id`.
    BridgeConnected { bridge_id: bridge::BridgeId },
    /// To a connected Mic bridge: each of its channels, switched on or not,
    /// and its name. Sent after [`ServerMessage::BridgeConnected`] and
    /// whenever the Stage changes Local mics.
    BridgeChannels {
        channels: Vec<bridge::BridgeChannelSettings>,
    },
    /// To a connected Mic bridge: whether the Stage's Mics screen is open.
    /// Sent after [`ServerMessage::BridgeChannels`] on connect and whenever
    /// it changes. While it is open the bridge opens every interface and
    /// meters every channel; otherwise only those with a switched-on channel.
    BridgeMicsScreen { open: bool },
    /// To a connected Mic bridge: its channels whose detectors run now,
    /// each a switched-on Local mic seated in the Song that plays (paused
    /// included). Sent whenever that set changes (not on connect while it
    /// is empty). The bridge sends Pitch readings for exactly these.
    BridgeDetecting { channels: Vec<BridgeLocalMic> },
    /// To a connected Mic bridge: Switch to Pro Audio was pressed on the
    /// Stage for its interface `device_name`. The bridge tries the switch
    /// itself, as if its own button had been pressed; it never switches
    /// otherwise.
    BridgeSwitchProfile { device_name: String },
    /// Stage only: meter levels of a Mic bridge's Local mics, ten times a
    /// second each.
    LocalMicLevels { levels: Vec<bridge::LocalMicLevel> },
}

/// What a [`ServerMessage::Changed`] notice says changed: each topic names
/// HTTP data the frontend refetches. Each area adds a topic per HTTP
/// resource (library, profiles, downloads, ...).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ChangeTopic {
    /// `GET /api/server-info` changed (for example the Library became
    /// read-only or writable again).
    ServerInfo,
    /// `GET /api/profiles` and `GET /api/profiles/{id}`.
    Profiles,
    /// The Library index: `GET /api/songs`, `GET /api/songs/{id}`,
    /// `GET /api/library/problems` and `GET /api/library/scan`.
    Library,
    /// `GET /api/mic-settings`.
    MicSettings,
    /// `GET /api/mic-bridges`: approved bridges (open or closed, with their
    /// channels) and bridges waiting for approval.
    MicBridges,
    /// The USDB mirror: `GET /api/usdb/mirror` (and, once #193 adds it, the
    /// USDB search over the mirror). Sent after every stored list page and
    /// when a mirror run starts or ends.
    UsdbMirror,
    /// `GET /api/stage-options`: the Stage options (Setup › Options).
    StageOptions,
}

/// Every user-facing message from the server (errors, rejections and toast
/// events): a code plus its parameters, `{ "code": ..., "params": {...} }`.
/// The frontend turns it into text with `t(code, params)`; the server never
/// sends on-screen English.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "code",
    content = "params",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum UserMessage {
    /// The Admin PIN attempt was wrong.
    WrongPin,
    /// The action is guarded and this browser holds no live Unlock.
    UnlockRequired,
    /// The action writes the Library and the Library is read-only, whatever
    /// the Unlock.
    LibraryReadOnly,
    /// Becoming the Stage needs the Admin PIN: this browser is not a
    /// remembered Stage browser.
    StagePinRequired,
    /// The text was not a valid [`ClientMessage`].
    InvalidMessage,
    /// Only the active Stage may do this.
    NotTheStage,
    /// Something failed on the server; its log says what.
    ServerError,
    /// A Profile name is empty once surrounding spaces are trimmed.
    ProfileNameEmpty,
    /// A Profile name is longer than `max_length` characters once
    /// surrounding spaces are trimmed.
    ProfileNameTooLong { max_length: u32 },
    /// A Profile already has this name (ignoring case and surrounding
    /// spaces); the person is offered that Profile. Also refuses a Guest
    /// name, so the Phone can ask "Are you <name>?".
    ProfileNameTaken { profile_id: profile::ProfileId },
    /// No Profile has this id (it was deleted, or never existed).
    ProfileNotFound,
    /// The Join code is not the current Party's ("That code is not on the Stage").
    JoinCodeWrong,
    /// All twelve Party colours are held, so no new Party member can enter
    /// (and no new Profile can be created).
    PartyFull,
    /// A Guest in the current Party already has this name, ignoring case and
    /// surrounding spaces ("Someone already has that name tonight"). Refuses
    /// a new Guest, a new Profile and a rename alike.
    NameTakenTonight { member_id: PartyMemberId },
    /// Another Party member holds this colour; only free colours can be
    /// picked inside the Party.
    ColourTaken,
    /// No Party member has this id (it left, or the Party ended).
    MemberNotFound,
    /// Only a Phone that has joined the Party (with an identity) or the
    /// Stage may do this.
    NotInParty,
    /// The job was cancelled.
    JobCancelled,
    /// A restart interrupted the job, and its kind does not run again.
    JobInterrupted,
    /// A tool the job needs (`ffmpeg`, `yt-dlp`, ...) is not installed.
    ToolNotFound { tool: String },
    /// A tool the job ran failed; `exit_code` is `null` when a signal ended it.
    ToolFailed {
        tool: String,
        exit_code: Option<i32>,
    },
    /// The Song is not in the Library (or cannot play), so it cannot be queued.
    SongNotInLibrary,
    /// The Song's audio is still being prepared, so it cannot be queued yet.
    SongPreparing,
    /// No Request in the Queue has this id (it left the Queue).
    RequestNotFound,
    /// The Request cannot move there: the head never moves, nothing moves
    /// above it, and nothing moves past the end.
    RequestCannotMove,
    /// More requested Players than a Line-up has seats.
    TooManyPlayers { max: u32 },
    /// A requested Player is not a Party member.
    PlayerNotInParty,
    /// A Party member is named twice among the requested Players.
    PlayerTwice,
    /// The Party member sits in the Line-up ("singing"), so it cannot leave
    /// or be removed: take it off the Song first.
    MemberSinging,
    /// The Profile sings in the playing Song (seated, or its Phone is a
    /// seat's Mic), so it cannot be deleted until the Song ends.
    ProfileSinging,
    /// A Phone cannot remove its own Party member from the people list; it
    /// uses Leave party instead.
    UseLeaveParty,
    /// No Line-up waits for this Request: it is not the head, or its Song
    /// has started.
    LineUpNotWaiting,
    /// The Line-up has no seat with this number (it was taken off).
    SeatNotFound,
    /// Another seat already uses this Mic; each Mic serves one seat.
    MicInUse,
    /// This Mic is neither a joined Phone nor a switched-on Local mic.
    MicNotAvailable,
    /// Find it: the Local mic to re-link is not kept (any more).
    LocalMicNotFound,
    /// Find it: the chosen channel is already a Local mic.
    ChannelAlreadyLocalMic,
    /// Only a duet's seats choose a Voice.
    NotADuet,
    /// The Line-up cannot start yet: see its warnings.
    LineUpNotReady,
    /// No Stage is open to play the Song.
    NoStage,
    /// That Request's Song is not playing.
    NoSongPlaying,
    /// The Request's Song is playing, so it cannot be removed: Skip or End
    /// does that.
    RequestPlaying,
    /// A seat's Difficulty is locked from Start until the Song ends.
    DifficultyLocked,
    /// No results are showing.
    NoResults,
    /// Only a Mic bridge, on its own WebSocket, may do this.
    NotABridge,
    /// No Mic bridge waits for approval under this id (it closed, or was
    /// approved already).
    BridgeRequestNotFound,
    /// No approved Mic bridge has this id (Forget).
    BridgeNotFound,
    /// Too many wrong Admin PIN guesses in a row: a wait runs, shared by
    /// every browser, and no PIN (not even the correct one) is checked for
    /// `seconds_left` more seconds. Sent over HTTP with `429`.
    AdminPinWait { seconds_left: u32 },
    /// The USDB username and password are not set, so OpenStar does not
    /// contact USDB.
    UsdbCredentialsMissing,
    /// USDB did not accept the username and password.
    UsdbLoginFailed,
    /// USDB still answered "not logged in" after OpenStar logged in again.
    UsdbNotLoggedIn,
    /// USDB could not be reached.
    UsdbUnreachable,
    /// USDB kept answering HTTP `status` (429 or 5xx); OpenStar gave up
    /// after backing off.
    UsdbGaveUp { status: u16 },
    /// USDB answered with an HTTP `status` OpenStar did not expect.
    UsdbUnexpectedStatus { status: u16 },
    /// The USDB song is already in the Library (a Song carries its USDB
    /// id), so it is not downloaded again. Checked when a Download starts
    /// and again just before it moves into the Library.
    UsdbSongInLibrary,
    /// A Download of the same USDB song is already waiting or running, so a
    /// second one is not started.
    UsdbSongDownloading,
    /// USDB's text page for the song held no text (no such song, or a page
    /// OpenStar does not know).
    UsdbNoSongText,
    /// The Library's parser would reject the Download's `song.txt`, for
    /// `rejection`, so the Download stopped before fetching the video.
    UsdbTextRejected { rejection: song::TxtRejection },
    /// yt-dlp did not leave a `video.mp4` behind.
    VideoDownloadFailed,
    /// The Pitch track job could not listen to the Song: its audio could not
    /// be decoded, the job failed, or it ran past its 2-minute timeout
    /// ("Couldn't listen to this Song"). The drag tools still work.
    PitchTrackFailed,
    /// The Song's `.txt` changed on disk (its mtime or content) since
    /// OpenStar loaded it, so a Timing edit is not saved over it. Sent
    /// with `409`; reload the Song and edit again.
    SongFileChanged,
    /// The Song plays on the Stage now, so its timing cannot be saved or
    /// restored. Sent with `409`.
    SongPlaying,
    /// The Song started playing on the Stage after the Timing editor opened
    /// it (it may have stopped since), so the edit is not saved: the Notes
    /// may have moved under Players. Sent with `409`; open the Song again.
    SongStartedSinceOpened,
    /// The Song has no Original (`<name>.txt.orig`) to restore. Sent with
    /// `404`.
    NoOriginal,
    /// The Song's folder also holds `other_txt` (another Song, a rejected
    /// file or a duplicate; relative to the Library), so deleting the
    /// folder would take that with it. Nothing is moved. Sent with `409`.
    SongFolderShared { other_txt: String },
    /// The Song's `.txt` sits directly in the Library root, so it has no
    /// folder of its own to delete. Nothing is moved. Sent with `409`.
    SongInLibraryRoot,
    /// The trash holds no Song folder of this id (it was restored or
    /// purged). Sent with `404`.
    NotInTrash,
    /// A folder named `path` (relative to the Library) exists where the
    /// trashed Song folder would be restored, and OpenStar never writes into
    /// an existing folder. Nothing is moved. Sent with `409`.
    RestoreFolderExists { path: String },
    /// A Song plays on the Stage, so this (Check A/V sync) cannot start.
    NotWhileSongPlays,
    /// Check A/V sync does not run, so there is nothing to step.
    AvSyncNotRunning,
    /// Check A/V sync runs, so Calibrate mics cannot start.
    AvSyncRunning,
    /// Calibrate mics runs, so Check A/V sync cannot start.
    CalibrationRunning,
    /// The Calibration run is not at the step this needs (or not open).
    CalibrationNotRunning,
    /// No Mic is ticked on the Calibration checklist.
    NoMicsChosen,
    /// No chosen Mic is ready, so the tones cannot start.
    NoMicReady,
    /// This Phone is not chosen for the Calibration run.
    NotInCalibration,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_messages_are_tagged_by_type() {
        let ping: ClientMessage = serde_json::from_str(r#"{"type":"ping","nonce":7}"#).unwrap();
        assert_eq!(ping, ClientMessage::Ping { nonce: 7 });
        assert_eq!(
            serde_json::to_string(&ServerMessage::Pong { nonce: 7 }).unwrap(),
            r#"{"type":"pong","nonce":7}"#
        );
    }

    #[test]
    fn the_guard_and_pin_refusals_keep_their_json() {
        // What `ApiError` sent before it was folded into `UserMessage`.
        for (message, json) in [
            (UserMessage::WrongPin, r#"{"code":"wrongPin"}"#),
            (UserMessage::UnlockRequired, r#"{"code":"unlockRequired"}"#),
            (
                UserMessage::LibraryReadOnly,
                r#"{"code":"libraryReadOnly"}"#,
            ),
            (
                UserMessage::StagePinRequired,
                r#"{"code":"stagePinRequired"}"#,
            ),
        ] {
            assert_eq!(serde_json::to_string(&message).unwrap(), json);
        }
    }

    #[test]
    fn server_info_fields_are_camel_case() {
        let info = ServerInfo {
            version: "dev".into(),
            schema_version: 1,
            library_read_only: Some(LibraryReadOnly {
                code: LibraryReadOnlyCode::SongsFolderNotWritable,
                songs_dir: "/songs".into(),
            }),
            public_url: None,
        };
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"version":"dev","schemaVersion":1,"libraryReadOnly":{"code":"songsFolderNotWritable","songsDir":"/songs"},"publicUrl":null}"#
        );
    }
}
