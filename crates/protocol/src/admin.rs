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
//! - `POST /api/stage/trust` with a [`StageTrustRequest`]: Stage trust, the
//!   Admin PIN given once per browser before it may become the Stage. A
//!   browser already remembered as a Stage browser (by its Stage cookie)
//!   answers [`StageTrustStatus`] with no PIN; otherwise a correct PIN answers
//!   it and sets the long-lived Stage cookie, no PIN answers `403`
//!   [`ApiErrorCode::StagePinRequired`], and a wrong one `403`
//!   [`ApiErrorCode::WrongPin`]. The PIN shares the wrong-guess wait above.
//!   Stage trust is not an Unlock, and an Unlock is not Stage trust.
//! - `GET /ws/stage`, the Stage's WebSocket, refuses the upgrade of a browser
//!   without Stage trust with `403` [`ApiErrorCode::StagePinRequired`].
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

/// Body of `POST /api/stage/trust`: asking to be a Stage browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StageTrustRequest {
    /// The digits typed on the PIN pad; absent to ask whether this browser
    /// is already remembered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pin: Option<String>,
}

/// Whether this browser is a remembered Stage browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StageTrustStatus {
    pub trusted: bool,
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
    /// Becoming the Stage needs the Admin PIN: this browser is not a
    /// remembered Stage browser.
    StagePinRequired,
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
