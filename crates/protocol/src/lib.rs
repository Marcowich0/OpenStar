//! The single source of every HTTP body and WebSocket message.
//!
//! Each type derives `ts_rs::TS` with `#[ts(export)]`; running this crate's
//! tests writes the TypeScript types to `web/src/generated/`, which is
//! committed. `just check` fails when the committed files drift.

pub mod admin;
pub mod jobs;
pub mod library;
pub mod mics;
pub mod party;
pub mod pitch;
pub mod profile;
pub mod scoring;
pub mod song;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use party::{
    Actor, ChangeEvent, Identity, JoinAs, JoinCode, JoinedPhone, LineUp, LineUpEdit, LineUpWarning,
    MemberEdit, NewGuest, PartyEvent, PartyId, PartyMember, PartyMemberId, PartySnapshot, PhoneId,
    QueueMove, Request, RequestChange, RequestId, RequestKind, SEATS, Seat, SeatVoice, SeatWho,
};
pub use pitch::{MicId, PitchReading};
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
    /// One Pitch reading from this browser's Mic, relayed to the current
    /// Stage (dropped while there is none).
    PitchReading { reading: PitchReading },
    /// A clock-sync ping, relayed to the current Stage (dropped while there
    /// is none). `t0` is the send time on the sender's own clock, in ms.
    ClockPing { t0: f64 },
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
    /// Presents the browser's Phone id. A Phone sends it every time its
    /// WebSocket opens, before anything else. A Phone already in the current
    /// Party is back in at once with the same identity (silent rejoin). The
    /// answer is a [`ServerMessage::PhoneStatus`].
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
    /// The Stage's answer to this browser's [`ClientMessage::ClockPing`].
    ClockPong { t0: f64, ts: f64, epoch: f64 },
    /// Stage only: a Mic's WebSocket closed (one of the lost-Mic signals).
    MicClosed { mic: MicId },
    /// The answer to a [`ClientMessage::CheckJoinCode`] with the current code.
    JoinCodeValid { join_code: JoinCode },
    /// Sent to a connection after its [`ClientMessage::Hello`] or accepted
    /// [`ClientMessage::Join`]: the Party member its Phone uses now, or `null`
    /// when its Phone is not in the current Party and must join with the code.
    PhoneStatus { member_id: Option<PartyMemberId> },
    /// Sent to every connection of a Phone that was in the Party and no
    /// longer is (a new Party started, or its Party member left or was
    /// removed): it needs the Join code to come back.
    LeftParty,
    /// A background job was queued, started, made progress or ended (sent to
    /// every connection).
    JobChanged { job: jobs::Job },
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
    /// Only a duet's seats choose a Voice.
    NotADuet,
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
