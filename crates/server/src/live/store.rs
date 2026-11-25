//! Persisting the live state in SQLite, so it survives a restart.
//!
//! The placeholder state lives in `server_meta` under `placeholder:<stage id>`
//! until #48 replaces it with the Party's own tables.

use openstar_protocol::StageId;
use rusqlite::OptionalExtension;

use crate::db::Database;

fn key(stage_id: &StageId) -> String {
    format!("placeholder:{}", stage_id.0)
}

/// The persisted placeholder of `stage_id`, empty when none was saved.
pub async fn load_placeholder(db: &Database, stage_id: &StageId) -> anyhow::Result<String> {
    let key = key(stage_id);
    let value = db
        .call(move |conn| {
            conn.query_row(
                "SELECT value FROM server_meta WHERE key = ?1",
                [&key],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
        .await?;
    Ok(value.unwrap_or_default())
}

pub async fn save_placeholder(
    db: &Database,
    stage_id: &StageId,
    placeholder: String,
) -> anyhow::Result<()> {
    let key = key(stage_id);
    db.call(move |conn| {
        conn.execute(
            "INSERT INTO server_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            (&key, &placeholder),
        )
    })
    .await?;
    Ok(())
}
