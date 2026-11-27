//! Stage trust: the Admin PIN, given once per browser, before it may become
//! the Stage.
//!
//! A correct PIN at `POST /api/stage/trust` remembers the browser as a Stage
//! browser: a random token in its own long-lived HttpOnly, SameSite=Strict
//! cookie ([`COOKIE_NAME`]), of which SQLite keeps only a hash with the PIN
//! fingerprint (table `stage_browsers`). The Stage's WebSocket upgrade
//! (`GET /ws/stage`) requires it, so becoming the Stage, taking it over and
//! taking it back are all HTTP requests; no WebSocket message makes a browser
//! the Stage.
//!
//! Stage trust is not an Unlock, and an Unlock is not Stage trust: the two
//! have separate cookies and tables, and giving the PIN for one never grants
//! the other. A plain restart keeps remembered Stage browsers; a restart with
//! a different Admin PIN forgets every one remembered with the old PIN (its
//! row is removed when it is next checked). The PIN goes through the shared
//! wrong-guess wait ([`AdminPin::check`](crate::pin_wait::AdminPin::check)).
//!
//! The Stage's own trusted actions can rely on [`is_trusted`].

use axum::Json;
use axum::extract::State;
use axum::http::header::SET_COOKIE;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use openstar_protocol::UserMessage;
use openstar_protocol::admin::{StageTrustRequest, StageTrustStatus};
use rusqlite::OptionalExtension;

use crate::AppState;
use crate::pin_wait::{ClientAddress, PinCheck};
use crate::unlock::{cookie_value, new_token, refusal, token_hash, wait_refusal};

/// The name of the Stage cookie.
pub const COOKIE_NAME: &str = "openstar_stage";

/// How long the browser keeps the Stage cookie: 400 days, the longest
/// Chromium allows. The server forgets the browser only when the PIN changes.
const COOKIE_MAX_AGE_SECONDS: u32 = 400 * 24 * 60 * 60;

fn internal_error(error: anyhow::Error) -> Response {
    tracing::error!(?error, "checking Stage trust");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

/// `403` with [`UserMessage::StagePinRequired`].
pub(crate) fn stage_pin_required() -> Response {
    refusal(StatusCode::FORBIDDEN, UserMessage::StagePinRequired)
}

/// Whether the request comes from a remembered Stage browser: it carries a
/// Stage cookie whose token was remembered with the running Admin PIN. A row
/// remembered with another PIN is removed.
pub(crate) async fn is_trusted(state: &AppState, headers: &HeaderMap) -> anyhow::Result<bool> {
    let Some(token) = cookie_value(headers, COOKIE_NAME) else {
        return Ok(false);
    };
    let hash = token_hash(&token);
    let fingerprint = state.admin_pin.fingerprint().to_vec();
    state
        .db
        .call(move |conn| {
            let stored: Option<Vec<u8>> = conn
                .query_row(
                    "SELECT pin_fingerprint FROM stage_browsers WHERE token_hash = ?1",
                    [&hash],
                    |r| r.get(0),
                )
                .optional()?;
            match stored {
                None => Ok(false),
                Some(stored) if stored == fingerprint => Ok(true),
                Some(_) => {
                    conn.execute("DELETE FROM stage_browsers WHERE token_hash = ?1", [&hash])?;
                    Ok(false)
                }
            }
        })
        .await
}

/// The refusal for a request without Stage trust, or `None` when it has it.
pub(crate) async fn refusal_without_trust(
    state: &AppState,
    headers: &HeaderMap,
) -> Option<Response> {
    match is_trusted(state, headers).await {
        Ok(true) => None,
        Ok(false) => Some(stage_pin_required()),
        Err(error) => Some(internal_error(error)),
    }
}

fn trusted() -> Json<StageTrustStatus> {
    Json(StageTrustStatus { trusted: true })
}

/// `POST /api/stage/trust`: a remembered Stage browser is answered with no
/// PIN (and none is checked); any other browser needs a correct Admin PIN,
/// which remembers it.
pub async fn trust(
    State(state): State<AppState>,
    client: ClientAddress,
    headers: HeaderMap,
    Json(request): Json<StageTrustRequest>,
) -> Response {
    match is_trusted(&state, &headers).await {
        Ok(true) => return trusted().into_response(),
        Ok(false) => {}
        Err(error) => return internal_error(error),
    }
    let Some(pin) = request.pin else {
        return stage_pin_required();
    };
    match state.admin_pin.check(&pin, &state.clock, &client) {
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
                "INSERT INTO stage_browsers (token_hash, pin_fingerprint, trusted_at_ms) \
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![hash, fingerprint, now],
            )
        })
        .await;
    if let Err(error) = stored {
        return internal_error(error);
    }
    tracing::info!("a browser gave the Admin PIN and is remembered as a Stage browser");
    ([(SET_COOKIE, cookie(&token))], trusted()).into_response()
}

fn cookie(token: &str) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={COOKIE_MAX_AGE_SECONDS}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("openstar_stage=; Max-Age=0"))
}
