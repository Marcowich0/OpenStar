//! The single source of every HTTP body and WebSocket message.
//!
//! Each type derives `ts_rs::TS` with `#[ts(export)]`; running this crate's
//! tests writes the TypeScript types to `web/src/generated/`, which is
//! committed. `just check` fails when the committed files drift.

pub mod admin;
pub mod jobs;
pub mod library;
pub mod party;
pub mod pitch;
pub mod profile;
pub mod song;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use party::{Actor, ChangeEvent, JoinCode, PartyEvent, PartyId, PartyMemberId, PartySnapshot};
pub use pitch::{MicId, PitchReading};

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
    /// `GET /api/profiles` and `GET /api/profiles/{id}`.
    Profiles,
    /// The Library index: `GET /api/songs`, `GET /api/songs/{id}`,
    /// `GET /api/library/problems` and `GET /api/library/scan`.
    Library,
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
    /// Another Profile already has this name (ignoring case and surrounding
    /// spaces); the person is offered that Profile.
    ProfileNameTaken { profile_id: profile::ProfileId },
    /// No Profile has this id (it was deleted, or never existed).
    ProfileNotFound,
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
