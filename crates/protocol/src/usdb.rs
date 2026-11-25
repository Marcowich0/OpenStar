//! USDB, the song database Downloads come from.
//!
//! - `GET /api/usdb/status`: the [`UsdbStatus`], for the Downloads section's
//!   notices (not guarded).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

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
            serde_json::to_string(&crate::UserMessage::UsdbGaveUp { status: 503 }).unwrap(),
            r#"{"code":"usdbGaveUp","params":{"status":503}}"#
        );
        assert_eq!(
            serde_json::to_string(&crate::UserMessage::UsdbUnreachable).unwrap(),
            r#"{"code":"usdbUnreachable"}"#
        );
    }
}
