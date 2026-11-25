//! What is kept per (Stage browser, Stage output), across Parties and
//! restarts: the OpenStar volume. The Stage browser is the random id the
//! Stage keeps in local storage (`stageBrowserId` in
//! `web/src/mics/localMics.ts`); the Stage output is its output key (the
//! default `audiooutput` label without "Default - "). Both are kept as the
//! Stage sends them. The live-state task reads and writes it when the Stage
//! reports its output and when the volume steps.

use openstar_protocol::volume::VOLUME_DEFAULT;
use rusqlite::{OptionalExtension, params};

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
