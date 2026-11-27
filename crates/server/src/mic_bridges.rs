//! Approved Mic bridges, kept across Parties and restarts, and the rules of
//! their approval tokens and join codes. Which bridges are open or waiting
//! is live state, owned by the live-state task (`live/mod.rs`); reads are
//! `GET /api/mic-bridges`, answered by that task.
//!
//! The approval token is the bridge's identity. The server keeps only its
//! SHA-256 ([`bridge_id_of`]), which is also the public [`BridgeId`], so a
//! leaked id or database never lets anyone pose as the bridge.

use std::fmt::Write as _;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::UserMessage;
use openstar_protocol::bridge::BridgeId;
use rusqlite::params;
use sha2::{Digest, Sha256};

use crate::AppState;
use crate::db::Database;

/// The most characters of a host name the server keeps.
pub const MAX_HOST_NAME_CHARS: usize = 64;

/// An approved bridge as kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Approved {
    pub bridge_id: BridgeId,
    pub host_name: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// A new approval token: 32 random bytes as hex.
pub fn new_token() -> anyhow::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| anyhow::anyhow!("no OS randomness: {error}"))?;
    Ok(hex(&bytes))
}

/// The public id of the bridge holding `token`.
pub fn bridge_id_of(token: &str) -> BridgeId {
    BridgeId(hex(&Sha256::digest(token.as_bytes())))
}

/// A 4-digit code that no code in `taken` equals.
pub fn draw_code(taken: &[&str]) -> anyhow::Result<String> {
    loop {
        let mut bytes = [0_u8; 2];
        getrandom::fill(&mut bytes)
            .map_err(|error| anyhow::anyhow!("no OS randomness: {error}"))?;
        let code = format!("{:04}", u16::from_le_bytes(bytes) % 10_000);
        if !taken.contains(&code.as_str()) {
            return Ok(code);
        }
    }
}

/// A host name as kept: trimmed, at most [`MAX_HOST_NAME_CHARS`].
pub fn clean_host_name(name: &str) -> String {
    name.trim().chars().take(MAX_HOST_NAME_CHARS).collect()
}

/// Every approved bridge, in order of approval.
pub async fn load(db: &Database) -> anyhow::Result<Vec<Approved>> {
    db.call(|conn| {
        let mut statement =
            conn.prepare("SELECT bridge_id, host_name FROM mic_bridges ORDER BY seq")?;
        let rows = statement.query_map([], |row| {
            Ok(Approved {
                bridge_id: BridgeId(row.get(0)?),
                host_name: row.get(1)?,
            })
        })?;
        rows.collect()
    })
    .await
}

/// Keeps a newly approved bridge, last in the order of approval.
pub async fn approve(db: &Database, approved: Approved, now_ms: i64) -> anyhow::Result<()> {
    db.call(move |conn| {
        conn.execute(
            "INSERT INTO mic_bridges (bridge_id, host_name, approved_at_ms) VALUES (?1, ?2, ?3)",
            params![approved.bridge_id.0, approved.host_name, now_ms],
        )?;
        Ok(())
    })
    .await
}

/// Keeps the host name an approved bridge said last.
pub async fn set_host_name(db: &Database, approved: Approved) -> anyhow::Result<()> {
    db.call(move |conn| {
        conn.execute(
            "UPDATE mic_bridges SET host_name = ?2 WHERE bridge_id = ?1",
            params![approved.bridge_id.0, approved.host_name],
        )?;
        Ok(())
    })
    .await
}

/// The start of every Local mic id of bridge `bridge_id`
/// ([`openstar_protocol::bridge::bridge_local_mic_id`]).
fn local_mic_id_prefix(bridge_id: &BridgeId) -> String {
    format!("bridge:{}:", bridge_id.0)
}

/// Forget: removes approved bridge `bridge_id` and its Local mics with every
/// Mic setting stored against them (at every Stage output), in one
/// transaction. Says whether the bridge was approved.
pub async fn forget(db: &Database, bridge_id: BridgeId) -> anyhow::Result<bool> {
    db.call(move |conn| {
        let tx = conn.transaction()?;
        let forgotten = tx.execute(
            "DELETE FROM mic_bridges WHERE bridge_id = ?1",
            params![bridge_id.0],
        )? > 0;
        if forgotten {
            let prefix = local_mic_id_prefix(&bridge_id);
            tx.execute(
                "DELETE FROM local_mics WHERE substr(id, 1, length(?1)) = ?1",
                params![prefix],
            )?;
            tx.execute(
                "DELETE FROM mic_settings
                 WHERE mic_kind = 'localMic' AND substr(mic_id, 1, length(?1)) = ?1",
                params![prefix],
            )?;
        }
        tx.commit()?;
        Ok(forgotten)
    })
    .await
}

/// `DELETE /api/mic-bridges/{bridgeId}` (guarded: it deletes kept data):
/// `204` once the bridge and its Local mics are forgotten and its connection
/// closed, `404 bridgeNotFound` when no bridge with that id is approved.
pub(crate) async fn forget_bridge(
    State(state): State<AppState>,
    Path(bridge_id): Path<String>,
) -> Response {
    match state.live.forget_bridge(BridgeId(bridge_id)).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(UserMessage::BridgeNotFound)).into_response(),
        Err(error) => {
            tracing::error!(?error, "forgetting a Mic bridge");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(UserMessage::ServerError),
            )
                .into_response()
        }
    }
}

/// `GET /api/mic-bridges`.
pub(crate) async fn read(State(state): State<AppState>) -> Response {
    match state.live.mic_bridges().await {
        Some(bridges) => Json(bridges).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(UserMessage::ServerError),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bridge_id_is_the_sha256_of_the_token() {
        assert_eq!(
            bridge_id_of("abc").0,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn tokens_are_long_and_never_repeat() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[test]
    fn a_code_is_four_digits_and_not_one_taken() {
        let taken: Vec<String> = (0..9_999).map(|n| format!("{n:04}")).collect();
        let taken: Vec<&str> = taken.iter().map(String::as_str).collect();
        assert_eq!(draw_code(&taken).unwrap(), "9999");
    }

    #[test]
    fn every_local_mic_id_of_a_bridge_starts_with_its_prefix() {
        let id = BridgeId("ab12".into());
        let local_mic_id = openstar_protocol::bridge::bridge_local_mic_id(&id, "usb:x", 3);
        assert!(local_mic_id.starts_with(&local_mic_id_prefix(&id)));
        let other =
            openstar_protocol::bridge::bridge_local_mic_id(&BridgeId("ab123".into()), "x", 0);
        assert!(!other.starts_with(&local_mic_id_prefix(&id)));
    }

    #[test]
    fn host_names_are_trimmed_and_capped() {
        assert_eq!(clean_host_name("  hermes \n"), "hermes");
        assert_eq!(clean_host_name(&"x".repeat(100)).len(), MAX_HOST_NAME_CHARS);
    }
}
