//! Job state in SQLite (the `jobs` table). Only the runner task calls these.

use openstar_protocol::UserMessage;
use openstar_protocol::jobs::JobId;
use rusqlite::params;

use crate::db::Database;

/// The stored state of a job (its progress is stored apart, [`set_percent`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoredState {
    Queued,
    Running,
    Done,
    Failed,
}

impl StoredState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "queued" => Self::Queued,
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
}

/// One row as stored: the job's parameters and error as JSON.
pub struct Row {
    pub id: JobId,
    pub params: String,
    pub state: StoredState,
    pub error: Option<String>,
}

/// Every kept job, oldest first.
pub async fn load(db: &Database) -> anyhow::Result<Vec<Row>> {
    db.call(|conn| {
        let mut statement =
            conn.prepare("SELECT id, params, state, error FROM jobs ORDER BY id")?;
        let rows = statement.query_map([], |row| {
            let state: String = row.get(2)?;
            Ok(Row {
                id: JobId(row.get(0)?),
                params: row.get(1)?,
                // An unknown state counts as failed.
                state: StoredState::parse(&state).unwrap_or(StoredState::Failed),
                error: row.get(3)?,
            })
        })?;
        rows.collect()
    })
    .await
}

/// Stores a new queued job and returns its id.
pub async fn insert(db: &Database, params: String) -> anyhow::Result<JobId> {
    db.call(move |conn| {
        conn.execute(
            "INSERT INTO jobs (params, state) VALUES (?1, 'queued')",
            params![params],
        )?;
        Ok(JobId(conn.last_insert_rowid()))
    })
    .await
}

/// Stores a job's new state, with the reason when it failed.
pub async fn set_state(
    db: &Database,
    id: JobId,
    state: StoredState,
    reason: Option<&UserMessage>,
) -> anyhow::Result<()> {
    let error = reason.map(serde_json::to_string).transpose()?;
    db.call(move |conn| {
        conn.execute(
            "UPDATE jobs SET state = ?2, error = ?3 WHERE id = ?1",
            params![id.0, state.as_str(), error],
        )?;
        Ok(())
    })
    .await
}

/// Stores how far a running job is (`None` once it starts again).
pub async fn set_percent(db: &Database, id: JobId, percent: Option<u8>) -> anyhow::Result<()> {
    db.call(move |conn| {
        conn.execute(
            "UPDATE jobs SET percent = ?2 WHERE id = ?1",
            params![id.0, percent],
        )?;
        Ok(())
    })
    .await
}
