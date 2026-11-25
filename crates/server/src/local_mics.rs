//! Local mics: each one's name and whether it is switched on, kept across
//! Parties and restarts. The Stage finds its channels and makes their ids
//! (`web/src/mics/localMics.ts`); the server keeps what it is sent. Writes
//! come over the active Stage's WebSocket ([`switch`], called by the
//! live-state task); reads are `GET /api/local-mics`.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::UserMessage;
use openstar_protocol::mics::{LocalMic, LocalMicSource};
use rusqlite::params;

use crate::AppState;
use crate::db::Database;

/// Switches a Local mic on or off. A new one is kept with an empty name;
/// a known one keeps its name, and its source becomes `source` (a device's
/// label may have changed).
pub async fn switch(
    db: Database,
    local_mic_id: String,
    source: LocalMicSource,
    switched_on: bool,
) -> anyhow::Result<()> {
    let source = serde_json::to_string(&source)?;
    db.call(move |conn| {
        conn.execute(
            "INSERT INTO local_mics (id, source, name, switched_on)
             VALUES (?1, ?2, '', ?3)
             ON CONFLICT (id) DO UPDATE SET
                 source      = excluded.source,
                 switched_on = excluded.switched_on",
            params![local_mic_id, source, switched_on],
        )?;
        Ok(())
    })
    .await
}

/// Every kept Local mic, by id.
pub async fn all(db: &Database) -> anyhow::Result<Vec<LocalMic>> {
    let rows: Vec<(String, String, String, bool)> = db
        .call(|conn| {
            let mut statement = conn
                .prepare("SELECT id, source, name, switched_on FROM local_mics ORDER BY id")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?;
            rows.collect()
        })
        .await?;
    rows.into_iter()
        .map(|(local_mic_id, source, name, switched_on)| {
            Ok(LocalMic {
                local_mic_id,
                source: serde_json::from_str(&source)?,
                name,
                switched_on,
            })
        })
        .collect()
}

/// `GET /api/local-mics`.
pub(crate) async fn read(State(state): State<AppState>) -> Response {
    match all(&state.db).await {
        Ok(mics) => Json(mics).into_response(),
        Err(error) => {
            tracing::error!(?error, "reading Local mics");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(UserMessage::ServerError),
            )
                .into_response()
        }
    }
}
