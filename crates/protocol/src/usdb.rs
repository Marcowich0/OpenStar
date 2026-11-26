//! USDB, the song database Downloads come from.
//!
//! - `GET /api/usdb/status`: the [`UsdbStatus`], for the Downloads section's
//!   notices (not guarded).
//! - `GET /api/usdb/mirror`: the [`UsdbMirrorStatus`] (not guarded).
//! - `POST /api/usdb/mirror/refresh`: the Downloads section asks for a fresh
//!   mirror when it opens; an update starts only when the mirror is more than
//!   a day old (a full refetch when one is due). Answers the
//!   [`UsdbMirrorStatus`] (not guarded).
//! - `POST /api/usdb/mirror/refetch`: starts a full refetch by hand unless a
//!   mirror run is already queued or running. Answers the
//!   [`UsdbMirrorStatus`] (not guarded: the mirror is a copy of USDB, not
//!   kept data).
//!
//! Progress and completion of a mirror run reach browsers as
//! [`ServerMessage::JobChanged`](crate::ServerMessage::JobChanged) (kinds
//! `usdbMirrorRefetch` and `usdbMirrorUpdate`) and as
//! [`ChangeTopic::UsdbMirror`](crate::ChangeTopic::UsdbMirror) notices.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::UserMessage;

/// Body of `GET /api/usdb/status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsdbStatus {
    pub state: UsdbState,
}

/// Where OpenStar's USDB login stands. Only `loggedIn` lets Downloads and
/// the mirror run; every other state is a notice in the Downloads section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UsdbState {
    /// `OPENSTAR_USDB_USERNAME` and `OPENSTAR_USDB_PASSWORD` are not set, so
    /// OpenStar never contacts USDB.
    CredentialsMissing,
    /// The login made at start is still being checked.
    Checking,
    /// The profile page shows the login.
    LoggedIn,
    /// USDB did not accept the username and password.
    LoginFailed,
    /// USDB could not be reached (no connection, or no answer in time).
    Unreachable,
    /// USDB kept answering "too many requests" or a server error, and
    /// OpenStar gave up after backing off.
    GaveUp,
}

/// Body of `GET /api/usdb/mirror` and of the mirror's `POST` endpoints:
/// where OpenStar's copy of USDB's song list stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsdbMirrorStatus {
    pub state: UsdbMirrorState,
    /// How many USDB songs the mirror holds now (searchable at once, also
    /// while it fills).
    pub songs: u32,
    /// When the last mirror run (update or full refetch) ended well, in Unix
    /// milliseconds; `null` before the first one.
    #[ts(type = "number | null")]
    pub last_refreshed_ms: Option<i64>,
    /// When the last full refetch ended well, in Unix milliseconds; `null`
    /// while the first fill has not finished.
    #[ts(type = "number | null")]
    pub last_full_ms: Option<i64>,
    /// Why the latest mirror run failed, when it did and no run has started
    /// since.
    pub last_failure: Option<UserMessage>,
}

/// The mirror's state, for the Downloads section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum UsdbMirrorState {
    /// No mirror run can start, for `reason` (v1: `usdbCredentialsMissing`).
    Unavailable { reason: UserMessage },
    /// Nothing is mirrored and no run is queued or running.
    Empty,
    /// The first fill is queued or running; `percent` once known.
    Filling { percent: Option<u8> },
    /// A run is queued or running over a filled mirror: a full refetch when
    /// `full`, else an update.
    Refreshing { full: bool, percent: Option<u8> },
    /// Songs are mirrored but the first fill never finished (it failed or
    /// was cancelled); the next refresh starts it again.
    Incomplete,
    /// Filled, and refreshed less than a day ago.
    Fresh,
    /// Filled, and last refreshed more than a day ago.
    Stale,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_status_is_a_camel_case_code() {
        let status = UsdbStatus {
            state: UsdbState::CredentialsMissing,
        };
        assert_eq!(
            serde_json::to_string(&status).unwrap(),
            r#"{"state":"credentialsMissing"}"#
        );
    }

    #[test]
    fn usdb_errors_are_codes_with_parameters() {
        assert_eq!(
            serde_json::to_string(&UserMessage::UsdbGaveUp { status: 503 }).unwrap(),
            r#"{"code":"usdbGaveUp","params":{"status":503}}"#
        );
        assert_eq!(
            serde_json::to_string(&UserMessage::UsdbUnreachable).unwrap(),
            r#"{"code":"usdbUnreachable"}"#
        );
    }
}
