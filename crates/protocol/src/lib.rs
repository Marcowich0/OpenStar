//! The single source of every HTTP body and WebSocket message.
//!
//! Each type derives `ts_rs::TS` with `#[ts(export)]`; running this crate's
//! tests writes the TypeScript types to `web/src/generated/`, which is
//! committed. `just check` fails when the committed files drift.

pub mod admin;
pub mod library;
pub mod song;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

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

/// Body of `GET /api/placeholder`: the placeholder live state that stands in
/// for the Party until #48 replaces it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StagePlaceholder {
    pub stage_id: StageId,
    pub placeholder: String,
}

/// A message a browser sends over its WebSocket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ClientMessage {
    /// Asks the server to answer with a [`ServerMessage::Pong`] carrying the same nonce.
    Ping { nonce: u32 },
    /// Changes the placeholder live state for everyone. At most
    /// [`PLACEHOLDER_MAX_LENGTH`] characters. Replaced by the Party's
    /// messages in #48.
    SetPlaceholder { text: String },
}

/// The longest placeholder text, in characters.
pub const PLACEHOLDER_MAX_LENGTH: u32 = 1000;

/// A message the server sends over a WebSocket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
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
        placeholder: String,
    },
    /// The placeholder live state changed (sent to every connection).
    PlaceholderChanged {
        stage_id: StageId,
        placeholder: String,
    },
    /// HTTP data changed: the frontend refetches what each topic names.
    Changed { topics: Vec<ChangeTopic> },
}

/// What a [`ServerMessage::Changed`] notice says changed: each topic names
/// HTTP data the frontend refetches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ChangeTopic {
    /// `GET /api/placeholder`.
    Placeholder,
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
    /// The placeholder text is longer than `max_length` characters.
    PlaceholderTooLong { max_length: u32 },
    /// Something failed on the server; its log says what.
    ServerError,
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
