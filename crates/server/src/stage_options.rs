//! The Stage options (`openstar_protocol::stage_options`): one set for the
//! server, kept across Parties and restarts as one JSON row. Anyone reads
//! them at `GET /api/stage-options` and replaces them at
//! `PUT /api/stage-options` (a Phone changes some of them over the WebSocket,
//! [`update`]), with no Admin PIN: they change no Library file
//! and delete no kept data. A change tells every browser with
//! [`ChangeTopic::StageOptions`].
//!
//! The server itself reads one: the starting Difficulty, when a Guest enters
//! the Party and when a Profile is created ([`read_in`], inside the same
//! transaction). The others only change what the Stage does.

use axum::Json;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::stage_options::{StageOptionKey, StageOptions, StageOptionsChange};
use openstar_protocol::{ChangeTopic, UserMessage};
use rusqlite::{Connection, OptionalExtension, params};

use crate::AppState;
use crate::db::Database;

/// The stored Stage options, or the defaults when none are stored. A stored
/// set that no longer reads (it never should) reads as the defaults too.
pub(crate) fn read_in(conn: &Connection) -> rusqlite::Result<StageOptions> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT options FROM stage_options WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match stored {
        None => StageOptions::default(),
        Some(json) => serde_json::from_str(&json).unwrap_or_else(|error| {
            tracing::warn!(%error, "stored Stage options do not read; using the defaults");
            StageOptions::default()
        }),
    })
}

/// The Stage options (see [`read_in`]).
pub async fn get(db: &Database) -> anyhow::Result<StageOptions> {
    db.call(|conn| read_in(conn)).await
}

/// Stores `options` in place of the kept set (or the first one).
fn store_in(conn: &Connection, options: &StageOptions) -> rusqlite::Result<()> {
    let json = serde_json::to_string(options)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    conn.execute(
        "INSERT INTO stage_options (id, options) VALUES (1, ?1)
         ON CONFLICT (id) DO UPDATE SET options = excluded.options",
        params![json],
    )?;
    Ok(())
}

/// Stores `options` (already checked with [`StageOptions::is_valid`]).
pub async fn set(db: &Database, options: StageOptions) -> anyhow::Result<()> {
    db.call(move |conn| store_in(conn, &options)).await
}

/// Merges `change` onto the kept set and stores the result, in one
/// transaction, so a change from another device in between is kept.
/// Answers with the options that changed ([`StageOptions::apply`]), or
/// `None` when the merged set is not valid ([`StageOptions::is_valid`]);
/// then nothing is stored.
pub async fn update(
    db: &Database,
    change: StageOptionsChange,
) -> anyhow::Result<Option<Vec<StageOptionKey>>> {
    db.call(move |conn| {
        let tx = conn.transaction()?;
        let (after, changed) = read_in(&tx)?.apply(change);
        if !after.is_valid() {
            return Ok(None);
        }
        if !changed.is_empty() {
            store_in(&tx, &after)?;
            tx.commit()?;
        }
        Ok(Some(changed))
    })
    .await
}

fn invalid() -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(UserMessage::InvalidMessage),
    )
        .into_response()
}

fn server_error(error: anyhow::Error, doing: &str) -> Response {
    tracing::error!(?error, "{doing}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(UserMessage::ServerError),
    )
        .into_response()
}

/// `GET /api/stage-options`: the defaults while none are stored.
pub(crate) async fn read(State(state): State<AppState>) -> Response {
    match get(&state.db).await {
        Ok(options) => Json(options).into_response(),
        Err(error) => server_error(error, "reading the Stage options"),
    }
}

/// `PUT /api/stage-options`: stores the Stage options, answers with them and
/// tells every browser. Refused with `422 invalidMessage` when a value is
/// out of its range or does not read at all (a theme it does not have, a
/// number too large for its field, a body that is not the options).
pub(crate) async fn write(
    State(state): State<AppState>,
    body: Result<Json<StageOptions>, JsonRejection>,
) -> Response {
    let Ok(Json(options)) = body.inspect_err(|rejection| {
        tracing::debug!(%rejection, "Stage options that do not read");
    }) else {
        return invalid();
    };
    if !options.is_valid() {
        return invalid();
    }
    match set(&state.db, options.clone()).await {
        Ok(()) => {
            state.live.changed(vec![ChangeTopic::StageOptions]).await;
            Json(options).into_response()
        }
        Err(error) => server_error(error, "storing the Stage options"),
    }
}
