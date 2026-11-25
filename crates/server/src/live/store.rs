//! Persisting the live state in SQLite, so it survives a restart: the
//! current Party of each Stage, in `parties`.

use openstar_protocol::{JoinCode, PartyId, PartySnapshot, StageId};
use rusqlite::OptionalExtension;

use crate::db::Database;

/// The current Party of `stage_id`, if one has started.
pub async fn load_party(
    db: &Database,
    stage_id: &StageId,
) -> anyhow::Result<Option<PartySnapshot>> {
    let stage = stage_id.clone();
    db.call(move |conn| {
        conn.query_row(
            "SELECT id, join_code, started_at_ms FROM parties WHERE stage_id = ?1",
            [&stage.0],
            |row| {
                Ok(PartySnapshot {
                    party_id: PartyId(row.get(0)?),
                    stage_id: stage.clone(),
                    join_code: JoinCode(row.get(1)?),
                    started_at_ms: row.get(2)?,
                })
            },
        )
        .optional()
    })
    .await
}

/// Makes `party` the current Party of its Stage, replacing the one before.
pub async fn replace_party(db: &Database, party: &PartySnapshot) -> anyhow::Result<()> {
    let party = party.clone();
    db.call(move |conn| {
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM parties WHERE stage_id = ?1",
            [&party.stage_id.0],
        )?;
        tx.execute(
            "INSERT INTO parties (id, stage_id, join_code, started_at_ms) VALUES (?1, ?2, ?3, ?4)",
            (
                &party.party_id.0,
                &party.stage_id.0,
                &party.join_code.0,
                party.started_at_ms,
            ),
        )?;
        tx.commit()
    })
    .await
}
