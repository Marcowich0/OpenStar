//! The Admin PIN and the Unlock, over HTTP only: the WebSocket carries no
//! Unlock, Lock or guarded action.
//!
//! - `POST /api/unlock` with an [`UnlockRequest`]: a correct Admin PIN answers
//!   with an [`UnlockStatus`] and sets the Unlock cookie; a wrong one answers
//!   `403` with an [`ApiError`] whose code is [`ApiErrorCode::WrongPin`].
//!   After 5 wrong guesses in a row (from any browser) each further wrong
//!   guess starts a wait; while it runs every attempt, even the correct PIN,
//!   answers `429` with a `Retry-After` header and
//!   [`UserMessage::AdminPinWait`](crate::UserMessage::AdminPinWait).
//! - `GET /api/unlock`: the [`UnlockStatus`] of this browser. It does not reset
//!   the idle time.
//! - `POST /api/unlock/heartbeat`: resets the idle time of a live Unlock and
//!   answers with an [`UnlockStatus`]; without one it answers `401` with
//!   [`ApiErrorCode::UnlockRequired`] and creates nothing.
//! - `POST /api/lock`: ends this browser's Unlock, if any. Needs no Unlock.
//!
//! A guarded endpoint refuses a request without a live Unlock with `401` and
//! [`ApiErrorCode::UnlockRequired`]. A guarded endpoint that writes the
//! Library refuses every request with `409` and
//! [`ApiErrorCode::LibraryReadOnly`] while the Library is read-only.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Body of `POST /api/unlock`: one Admin PIN attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UnlockRequest {
    /// The digits typed on the PIN pad.
    pub pin: String,
}

/// Whether this browser holds an Unlock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UnlockStatus {
    pub unlocked: bool,
}

/// The body of an HTTP error answer: a code the frontend turns into text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApiError {
    pub code: ApiErrorCode,
}

/// Why an HTTP request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ApiErrorCode {
    /// The Admin PIN attempt was wrong.
    WrongPin,
    /// The action is guarded and this browser holds no live Unlock.
    UnlockRequired,
    /// The action writes the Library and the Library is read-only, whatever
    /// the Unlock.
    LibraryReadOnly,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_are_camel_case() {
        assert_eq!(
            serde_json::to_string(&ApiError {
                code: ApiErrorCode::UnlockRequired
            })
            .unwrap(),
            r#"{"code":"unlockRequired"}"#
        );
        assert_eq!(
            serde_json::to_string(&ApiErrorCode::WrongPin).unwrap(),
            r#""wrongPin""#
        );
    }
}
