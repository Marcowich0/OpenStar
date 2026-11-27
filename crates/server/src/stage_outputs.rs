//! What is kept per (Stage browser, Stage output), across Parties and
//! restarts: the OpenStar volume and the A/V offset. The Stage browser is the
//! random id a browser keeps in local storage (`stageBrowserId` in
//! `web/src/mics/localMics.ts`); the Stage output is its output key (the
//! default `audiooutput` label without "Default - "). Both are kept as the
//! browser sends them. The live-state task reads and writes the volume when
//! the Stage reports its output and when the volume steps. Any browser (the
//! Stage, a Timing-editor browser) reads and sets its own A/V offset at
//! `GET`/`PUT /api/av-offset`, with no Admin PIN.

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::UserMessage;
use openstar_protocol::av_offset::{AV_OFFSET_DEFAULT_MS, AvOffset, AvOffsetQuery, is_av_offset};
use openstar_protocol::volume::VOLUME_DEFAULT;
use rusqlite::{OptionalExtension, params};

use crate::AppState;
use crate::db::Database;

/// One Stage output of one Stage browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageOutput {
    pub stage_browser: String,
    pub stage_output: String,
}

/// The OpenStar volume stored for `output`, or 80 when none is stored.
pub async fn volume(db: &Database, output: &StageOutput) -> anyhow::Result<u8> {
    let StageOutput {
        stage_browser,
        stage_output,
    } = output.clone();
    let stored: Option<u8> = db
        .call(move |conn| {
            conn.query_row(
                "SELECT volume FROM stage_outputs
                 WHERE stage_browser = ?1 AND stage_output = ?2",
                params![stage_browser, stage_output],
                |row| row.get(0),
            )
            .optional()
        })
        .await?;
    Ok(stored.unwrap_or(VOLUME_DEFAULT))
}

/// Stores `volume` (0 to 100) for `output`.
pub async fn set_volume(db: &Database, output: &StageOutput, volume: u8) -> anyhow::Result<()> {
    let StageOutput {
        stage_browser,
        stage_output,
    } = output.clone();
    db.call(move |conn| {
        conn.execute(
            "INSERT INTO stage_outputs (stage_browser, stage_output, volume)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (stage_browser, stage_output) DO UPDATE SET
                 volume = excluded.volume",
            params![stage_browser, stage_output, volume],
        )?;
        Ok(())
    })
    .await
}

/// The A/V offset in ms stored for `output`, or 0 when none is stored.
pub async fn av_offset(db: &Database, output: &StageOutput) -> anyhow::Result<i32> {
    let StageOutput {
        stage_browser,
        stage_output,
    } = output.clone();
    let stored: Option<i32> = db
        .call(move |conn| {
            conn.query_row(
                "SELECT av_offset_ms FROM stage_outputs
                 WHERE stage_browser = ?1 AND stage_output = ?2",
                params![stage_browser, stage_output],
                |row| row.get(0),
            )
            .optional()
        })
        .await?;
    Ok(stored.unwrap_or(AV_OFFSET_DEFAULT_MS))
}

/// Stores `av_offset_ms` (an A/V offset, see [`is_av_offset`]) for `output`.
/// A new row gets the default volume.
pub async fn set_av_offset(
    db: &Database,
    output: &StageOutput,
    av_offset_ms: i32,
) -> anyhow::Result<()> {
    let StageOutput {
        stage_browser,
        stage_output,
    } = output.clone();
    db.call(move |conn| {
        conn.execute(
            "INSERT INTO stage_outputs (stage_browser, stage_output, volume, av_offset_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (stage_browser, stage_output) DO UPDATE SET
                 av_offset_ms = excluded.av_offset_ms",
            params![stage_browser, stage_output, VOLUME_DEFAULT, av_offset_ms],
        )?;
        Ok(())
    })
    .await
}

fn server_error(error: anyhow::Error, doing: &str) -> Response {
    tracing::error!(?error, "{doing}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(UserMessage::ServerError),
    )
        .into_response()
}

/// `GET /api/av-offset?browser=…&output=…`: 0 for an output nothing was
/// stored for.
pub(crate) async fn read_av_offset(
    State(state): State<AppState>,
    Query(query): Query<AvOffsetQuery>,
) -> Response {
    let output = StageOutput {
        stage_browser: query.browser,
        stage_output: query.output,
    };
    match av_offset(&state.db, &output).await {
        Ok(av_offset_ms) => Json(AvOffset {
            browser: output.stage_browser,
            output: output.stage_output,
            av_offset_ms,
        })
        .into_response(),
        Err(error) => server_error(error, "reading an A/V offset"),
    }
}

/// `PUT /api/av-offset`: stores the browser's A/V offset at its output and
/// answers with it. Refused with `422 invalidMessage` outside -300..=500 ms
/// or off the 10 ms grid.
pub(crate) async fn write_av_offset(
    State(state): State<AppState>,
    Json(body): Json<AvOffset>,
) -> Response {
    if !is_av_offset(body.av_offset_ms) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(UserMessage::InvalidMessage),
        )
            .into_response();
    }
    let output = StageOutput {
        stage_browser: body.browser.clone(),
        stage_output: body.output.clone(),
    };
    match set_av_offset(&state.db, &output, body.av_offset_ms).await {
        Ok(()) => Json(body).into_response(),
        Err(error) => server_error(error, "storing an A/V offset"),
    }
}
