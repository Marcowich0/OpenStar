//! Mic delays, bleed levels and Mic thresholds, kept per (Mic, Stage output).
//!
//! The Stage sends finished values (the arithmetic lives in TypeScript,
//! `web/src/mics/micSettings.ts`); the server only keeps them, across
//! Parties and restarts. Writes come over the active Stage's WebSocket and
//! are handled by the live-state task, which calls [`store_calibration`] and
//! [`set_threshold_by_hand`]. Reads are `GET /api/mic-settings`. Find it and
//! Forget (#122, #200) use [`move_local_mic`] and [`forget_local_mic`].

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::UserMessage;
use openstar_protocol::mics::{
    CalibrationResult, MicKey, MicSettingsEntry, MicSettingsQuery, StageOutputMicSettings,
    StoredCalibration, StoredMicSettings, StoredMicThreshold, ThresholdSetBy,
};
use rusqlite::params;

use crate::AppState;
use crate::db::Database;

const PHONE: &str = "phone";
const LOCAL_MIC: &str = "localMic";

fn key_parts(mic: &MicKey) -> (&'static str, &str) {
    match mic {
        MicKey::Phone { phone_id } => (PHONE, phone_id),
        MicKey::LocalMic { local_mic_id } => (LOCAL_MIC, local_mic_id),
    }
}

fn set_by_key(set_by: ThresholdSetBy) -> &'static str {
    match set_by {
        ThresholdSetBy::Calibration => "calibration",
        ThresholdSetBy::Hand => "hand",
    }
}

/// Stores a Calibration run's results at `stage_output`, in one transaction.
/// Only the Mics included are written; for each, the Mic delay and bleed
/// level are replaced, and its Mic threshold too when the result has one
/// (then marked set by Calibration). Every other value stays as it was.
pub async fn store_calibration(
    db: Database,
    stage_output: String,
    results: Vec<CalibrationResult>,
) -> anyhow::Result<()> {
    db.call(move |conn| {
        let tx = conn.transaction()?;
        for result in &results {
            let (kind, id) = key_parts(&result.mic);
            let set_by = result
                .mic_threshold_dbfs
                .map(|_| set_by_key(ThresholdSetBy::Calibration));
            tx.execute(
                "INSERT INTO mic_settings
                     (mic_kind, mic_id, stage_output, mic_delay_ms, bleed_level_dbfs,
                      threshold_dbfs, threshold_set_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (mic_kind, mic_id, stage_output) DO UPDATE SET
                     mic_delay_ms     = excluded.mic_delay_ms,
                     bleed_level_dbfs = excluded.bleed_level_dbfs,
                     threshold_dbfs   = coalesce(excluded.threshold_dbfs, threshold_dbfs),
                     threshold_set_by = coalesce(excluded.threshold_set_by, threshold_set_by)",
                params![
                    kind,
                    id,
                    stage_output,
                    result.mic_delay_ms,
                    result.bleed_level_dbfs,
                    result.mic_threshold_dbfs,
                    set_by,
                ],
            )?;
        }
        tx.commit()
    })
    .await
}

/// Sets a Local mic's Mic threshold by hand at `stage_output` (dBFS at the
/// reference volume), marked set by hand. Its Mic delay and bleed level, if
/// any, stay as they were; a never-calibrated Local mic gets none.
pub async fn set_threshold_by_hand(
    db: Database,
    stage_output: String,
    local_mic_id: String,
    reference_dbfs: f64,
) -> anyhow::Result<()> {
    db.call(move |conn| {
        conn.execute(
            "INSERT INTO mic_settings
                 (mic_kind, mic_id, stage_output, threshold_dbfs, threshold_set_by)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (mic_kind, mic_id, stage_output) DO UPDATE SET
                 threshold_dbfs   = excluded.threshold_dbfs,
                 threshold_set_by = excluded.threshold_set_by",
            params![
                LOCAL_MIC,
                local_mic_id,
                stage_output,
                reference_dbfs,
                set_by_key(ThresholdSetBy::Hand),
            ],
        )?;
        Ok(())
    })
    .await
}

/// Every Mic's values at `stage_output`; none for an output nothing was
/// stored for.
pub async fn at_stage_output(
    db: &Database,
    stage_output: String,
) -> anyhow::Result<Vec<MicSettingsEntry>> {
    db.call(move |conn| {
        let mut statement = conn.prepare(
            "SELECT mic_kind, mic_id, mic_delay_ms, bleed_level_dbfs,
                    threshold_dbfs, threshold_set_by
             FROM mic_settings WHERE stage_output = ?1
             ORDER BY mic_kind, mic_id",
        )?;
        let rows = statement.query_map([&stage_output], |row| {
            let kind: String = row.get(0)?;
            let id: String = row.get(1)?;
            let delay: Option<f64> = row.get(2)?;
            let bleed: Option<f64> = row.get(3)?;
            let threshold: Option<f64> = row.get(4)?;
            let set_by: Option<String> = row.get(5)?;
            let mic = if kind == PHONE {
                MicKey::Phone { phone_id: id }
            } else {
                MicKey::LocalMic { local_mic_id: id }
            };
            let calibration =
                delay
                    .zip(bleed)
                    .map(|(mic_delay_ms, bleed_level_dbfs)| StoredCalibration {
                        mic_delay_ms,
                        bleed_level_dbfs,
                    });
            let mic_threshold =
                threshold
                    .zip(set_by)
                    .map(|(reference_dbfs, set_by)| StoredMicThreshold {
                        reference_dbfs,
                        set_by: if set_by == "hand" {
                            ThresholdSetBy::Hand
                        } else {
                            ThresholdSetBy::Calibration
                        },
                    });
            Ok(MicSettingsEntry {
                mic,
                settings: StoredMicSettings {
                    calibration,
                    mic_threshold,
                },
            })
        })?;
        rows.collect()
    })
    .await
}

/// Find it: every value stored against Local mic id `from`, at every Stage
/// output, now belongs to `to`. Anything `to` had before is replaced.
pub async fn move_local_mic(db: &Database, from: &str, to: &str) -> anyhow::Result<()> {
    let (from, to) = (from.to_owned(), to.to_owned());
    db.call(move |conn| {
        let tx = conn.transaction()?;
        move_local_mic_in(&tx, &from, &to)?;
        tx.commit()
    })
    .await
}

/// [`move_local_mic`] inside a transaction the caller commits, so Find it
/// moves a Local mic's row and its Mic settings together.
pub(crate) fn move_local_mic_in(
    tx: &rusqlite::Transaction<'_>,
    from: &str,
    to: &str,
) -> rusqlite::Result<()> {
    if from != to {
        tx.execute(
            "DELETE FROM mic_settings WHERE mic_kind = ?1 AND mic_id = ?2",
            params![LOCAL_MIC, to],
        )?;
        tx.execute(
            "UPDATE mic_settings SET mic_id = ?3 WHERE mic_kind = ?1 AND mic_id = ?2",
            params![LOCAL_MIC, from, to],
        )?;
    }
    Ok(())
}

/// Forget: deletes every value stored against Local mic id `id`, at every
/// Stage output.
pub async fn forget_local_mic(db: &Database, id: &str) -> anyhow::Result<()> {
    let id = id.to_owned();
    db.call(move |conn| {
        conn.execute(
            "DELETE FROM mic_settings WHERE mic_kind = ?1 AND mic_id = ?2",
            params![LOCAL_MIC, id],
        )?;
        Ok(())
    })
    .await
}

/// `GET /api/mic-settings?stageOutput=…`.
pub(crate) async fn read(
    State(state): State<AppState>,
    Query(query): Query<MicSettingsQuery>,
) -> Response {
    match at_stage_output(&state.db, query.stage_output.clone()).await {
        Ok(mics) => Json(StageOutputMicSettings {
            stage_output: query.stage_output,
            mics,
        })
        .into_response(),
        Err(error) => {
            tracing::error!(?error, "reading Mic settings");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(UserMessage::ServerError),
            )
                .into_response()
        }
    }
}
