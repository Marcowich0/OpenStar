//! The Admin PIN check and the Unlock.
//!
//! A correct Admin PIN gives the browser an Unlock: a random token in an
//! HttpOnly, SameSite=Strict cookie. SQLite keeps only a hash of the token,
//! its last use and the PIN fingerprint, never the PIN. An Unlock is live
//! while its fingerprint matches the running PIN and it was last used less
//! than [`IDLE_LIMIT`] ago by the server [`Clock`](crate::clock::Clock).
//!
//! Guarded HTTP endpoints are classified as such in
//! [`endpoints`](crate::endpoints), whose guard calls [`refusal_without_unlock`]: it checks
//! the Unlock on the server and resets its idle time. The WebSocket carries no
//! Unlock, Lock or guarded action. The HTTP routes are listed in
//! `openstar_protocol::admin`.

use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::http::header::{COOKIE, RETRY_AFTER, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use openstar_protocol::UserMessage;
use openstar_protocol::admin::{UnlockRequest, UnlockStatus};
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

use crate::AppState;
use crate::pin_wait::{ClientAddress, PinCheck};

/// An Unlock ends after this long without a guarded action or a heartbeat.
pub const IDLE_LIMIT: Duration = Duration::from_secs(30 * 60);

/// The name of the Unlock cookie.
pub const COOKIE_NAME: &str = "openstar_unlock";

/// Bytes of randomness in an Unlock token.
const TOKEN_BYTES: usize = 32;

/// The SHA-256 fingerprint of an Admin PIN, the only form of the PIN that
/// reaches SQLite. Stored as a BLOB.
pub fn pin_fingerprint(pin: &str) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(b"openstar admin pin fingerprint v1\0");
    hasher.update(pin.as_bytes());
    hasher.finalize().to_vec()
}

pub(crate) fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub(crate) fn new_token() -> anyhow::Result<String> {
    let mut bytes = [0_u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| anyhow::anyhow!("no OS randomness: {error}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The Unlock token this request carries, if any.
fn token_from(headers: &HeaderMap) -> Option<String> {
    cookie_value(headers, COOKIE_NAME)
}

/// The value of the cookie `name` this request carries, if any and not empty.
pub(crate) fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(found, _)| *found == name)
        .map(|(_, value)| value.to_owned())
        .filter(|value| !value.is_empty())
}

/// What to do with a live Unlock when it is found.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Use {
    /// A guarded action or a heartbeat: the idle time starts again.
    Touch,
    /// The status request: only look.
    Look,
}

/// Whether `token` is a live Unlock. Removes the row of an Unlock that has
/// ended (idle too long, or made with another PIN).
async fn check(state: &AppState, token: &str, use_: Use) -> anyhow::Result<bool> {
    let hash = token_hash(token);
    let fingerprint = state.admin_pin.fingerprint().to_vec();
    let now = state.clock.now_millis();
    let limit = i64::try_from(IDLE_LIMIT.as_millis()).unwrap_or(i64::MAX);
    state
        .db
        .call(move |conn| {
            let tx = conn.transaction()?;
            let row: Option<(Vec<u8>, i64)> = tx
                .query_row(
                    "SELECT pin_fingerprint, last_used_ms FROM unlocks WHERE token_hash = ?1",
                    [&hash],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let live = match row {
                None => false,
                Some((stored, last_used)) => {
                    let live = stored == fingerprint && now.saturating_sub(last_used) < limit;
                    if !live {
                        tx.execute("DELETE FROM unlocks WHERE token_hash = ?1", [&hash])?;
                    } else if use_ == Use::Touch {
                        tx.execute(
                            "UPDATE unlocks SET last_used_ms = ?2 WHERE token_hash = ?1",
                            rusqlite::params![hash, now],
                        )?;
                    }
                    live
                }
            };
            tx.commit()?;
            Ok(live)
        })
        .await
}

/// Whether the request carries a live Unlock.
async fn check_request(state: &AppState, headers: &HeaderMap, use_: Use) -> anyhow::Result<bool> {
    match token_from(headers) {
        Some(token) => check(state, &token, use_).await,
        None => Ok(false),
    }
}

fn internal_error(error: anyhow::Error) -> Response {
    tracing::error!(?error, "checking an Unlock");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

pub(crate) fn refusal(status: StatusCode, message: UserMessage) -> Response {
    (status, Json(message)).into_response()
}

/// `429` with [`UserMessage::AdminPinWait`] and a matching `Retry-After`:
/// a wrong-guess wait runs, so no PIN was checked.
pub(crate) fn wait_refusal(seconds_left: u32) -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [(RETRY_AFTER, HeaderValue::from(seconds_left))],
        Json(UserMessage::AdminPinWait { seconds_left }),
    )
        .into_response()
}

fn unlock_required() -> Response {
    refusal(StatusCode::UNAUTHORIZED, UserMessage::UnlockRequired)
}

fn status(unlocked: bool) -> Json<UnlockStatus> {
    Json(UnlockStatus { unlocked })
}

fn cookie(value: &str, max_age: Option<u32>) -> HeaderValue {
    let max_age = max_age
        .map(|s| format!("; Max-Age={s}"))
        .unwrap_or_default();
    HeaderValue::from_str(&format!(
        "{COOKIE_NAME}={value}; Path=/; HttpOnly; SameSite=Strict{max_age}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("openstar_unlock=; Max-Age=0"))
}

/// The Unlock check of every guarded endpoint, run by the guard in
/// [`endpoints`](crate::endpoints) from the endpoint's classification. A
/// request without a live Unlock is refused with `401` and
/// [`UserMessage::UnlockRequired`]; a request with one resets its idle time
/// and gets `None`.
pub(crate) async fn refusal_without_unlock(
    state: &AppState,
    headers: &HeaderMap,
) -> Option<Response> {
    match check_request(state, headers, Use::Touch).await {
        Ok(true) => None,
        Ok(false) => Some(unlock_required()),
        Err(error) => Some(internal_error(error)),
    }
}

/// `POST /api/unlock`: one Admin PIN attempt.
/// The PIN goes through the shared wrong-guess wait
/// ([`AdminPin::check`](crate::pin_wait::AdminPin::check)).
pub async fn attempt(
    State(state): State<AppState>,
    client: ClientAddress,
    Json(request): Json<UnlockRequest>,
) -> Response {
    match state.admin_pin.check(&request.pin, &state.clock, &client) {
        PinCheck::Correct => {}
        PinCheck::Wrong => return refusal(StatusCode::FORBIDDEN, UserMessage::WrongPin),
        PinCheck::Wait { seconds_left } => return wait_refusal(seconds_left),
    }
    let token = match new_token() {
        Ok(token) => token,
        Err(error) => return internal_error(error),
    };
    let hash = token_hash(&token);
    let fingerprint = state.admin_pin.fingerprint().to_vec();
    let now = state.clock.now_millis();
    let stored = state
        .db
        .call(move |conn| {
            conn.execute(
                "INSERT INTO unlocks (token_hash, pin_fingerprint, last_used_ms) VALUES (?1, ?2, ?3)",
                rusqlite::params![hash, fingerprint, now],
            )
        })
        .await;
    if let Err(error) = stored {
        return internal_error(error);
    }
    tracing::info!("a browser was unlocked with the Admin PIN");
    ([(SET_COOKIE, cookie(&token, None))], status(true)).into_response()
}

/// `GET /api/unlock`: whether this browser holds an Unlock. Does not reset
/// the idle time.
pub async fn unlock_status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match check_request(&state, &headers, Use::Look).await {
        Ok(unlocked) => status(unlocked).into_response(),
        Err(error) => internal_error(error),
    }
}

/// `POST /api/unlock/heartbeat`: resets the idle time of a live Unlock. Never
/// creates or revives one: it is classified guarded, so the guard has already
/// checked the Unlock and reset its idle time.
pub async fn heartbeat() -> Json<UnlockStatus> {
    status(true)
}

/// `POST /api/lock`: ends this browser's Unlock at once. Needs no Unlock.
pub async fn lock(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = token_from(&headers) {
        let hash = token_hash(&token);
        let removed = state
            .db
            .call(move |conn| conn.execute("DELETE FROM unlocks WHERE token_hash = ?1", [hash]))
            .await;
        match removed {
            Ok(0) => {}
            Ok(_) => tracing::info!("a browser was locked"),
            Err(error) => return internal_error(error),
        }
    }
    ([(SET_COOKIE, cookie("", Some(0)))], status(false)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_unlock_cookie_is_found_among_others() {
        let mut headers = HeaderMap::new();
        headers.insert(
            COOKIE,
            HeaderValue::from_static("a=1; openstar_unlock=abc ;b=2"),
        );
        assert_eq!(token_from(&headers).as_deref(), Some("abc"));
        headers.insert(COOKIE, HeaderValue::from_static("openstar_unlock="));
        assert_eq!(token_from(&headers), None);
    }

    #[test]
    fn different_pins_have_different_fingerprints() {
        assert_ne!(pin_fingerprint("1234"), pin_fingerprint("12345"));
        assert_eq!(pin_fingerprint("1234"), pin_fingerprint("1234"));
    }
}
