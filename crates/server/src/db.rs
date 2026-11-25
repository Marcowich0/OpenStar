//! The SQLite database in the appdata folder.
//!
//! The connection is private: the only way to use it is [`Database::call`],
//! which runs the closure on a blocking thread, never on the async runtime.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use anyhow::Context;
use rusqlite::Connection;

/// File name of the database inside the appdata folder.
pub const DATABASE_FILE: &str = "openstar.db";

/// Schema migrations, oldest first. Migration `n` (1-based) brings the schema
/// to version `n`, kept in `PRAGMA user_version`. Never edit or reorder an
/// entry that has shipped; append a new one.
const MIGRATIONS: &[&str] = &[
    // 1: key-value facts about the database itself.
    "CREATE TABLE server_meta (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
    ) STRICT;",
    // 2: Unlocks. Only a hash of each browser's token and the Admin PIN's
    // fingerprint are kept, never the PIN.
    "CREATE TABLE unlocks (
        token_hash      BLOB PRIMARY KEY NOT NULL,
        pin_fingerprint BLOB NOT NULL,
        last_used_ms    INTEGER NOT NULL
    ) STRICT;",
    // 3: the current Party of each Stage (v1 has one Stage). A new Party
    // replaces the row; later Party tables hang off `parties.id`. Drops the
    // placeholder live state that stood in for the Party.
    "CREATE TABLE parties (
        id            TEXT PRIMARY KEY NOT NULL,
        stage_id      TEXT NOT NULL UNIQUE,
        join_code     TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL
    ) STRICT;
    DELETE FROM server_meta WHERE key LIKE 'placeholder:%';",
    // 4: Profiles. Colours and Difficulty are stored as keys, never hex
    // values; the avatar is a kind plus a reference, so an uploaded image can
    // join the built-in keys later. `name_key` is the trimmed, case-folded
    // name that uniqueness compares. AUTOINCREMENT: a deleted Profile's id is
    // never reused, since Phones remember Profiles by id.
    "CREATE TABLE profiles (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT NOT NULL,
        name_key         TEXT NOT NULL UNIQUE,
        avatar_kind      TEXT NOT NULL,
        avatar_ref       TEXT NOT NULL,
        favourite_colour TEXT NOT NULL,
        last_difficulty  TEXT NOT NULL,
        created_ms       INTEGER NOT NULL,
        last_sung_ms     INTEGER
    ) STRICT;",
];

/// The schema version this build migrates to.
pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

/// A handle to the database. Cheap to clone.
#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

/// What [`Database::open`] did.
pub struct Opened {
    pub database: Database,
    /// How many migrations this start applied.
    pub migrations_applied: usize,
}

impl Database {
    /// Opens (or creates) the database in `appdata_dir` in WAL mode and
    /// applies every pending migration.
    pub async fn open(appdata_dir: &Path) -> anyhow::Result<Opened> {
        let path = appdata_dir.join(DATABASE_FILE);
        tokio::task::spawn_blocking(move || -> anyhow::Result<Opened> {
            let mut conn = Connection::open(&path)
                .with_context(|| format!("opening the database {}", path.display()))?;
            let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
            anyhow::ensure!(mode == "wal", "the database refused WAL mode (got {mode})");
            conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;")?;
            let migrations_applied = migrate(&mut conn).context("migrating the database")?;
            Ok(Opened {
                database: Self {
                    conn: Arc::new(Mutex::new(conn)),
                },
                migrations_applied,
            })
        })
        .await?
    }

    /// Runs `f` with the connection on a blocking thread and returns its result.
    pub async fn call<F, R>(&self, f: F) -> anyhow::Result<R>
    where
        F: FnOnce(&mut Connection) -> rusqlite::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let conn = Arc::clone(&self.conn);
        let result = tokio::task::spawn_blocking(move || {
            let mut conn = conn.lock().unwrap_or_else(PoisonError::into_inner);
            f(&mut conn)
        })
        .await?;
        Ok(result?)
    }

    /// The schema version the database is at.
    pub async fn schema_version(&self) -> anyhow::Result<u32> {
        self.call(|conn| conn.query_row("PRAGMA user_version", [], |r| r.get(0)))
            .await
    }
}

fn migrate(conn: &mut Connection) -> rusqlite::Result<usize> {
    let current: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let mut applied = 0;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let version = u32::try_from(index + 1).unwrap_or(u32::MAX);
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
        tracing::info!(version, "applied database migration");
        applied += 1;
    }
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn calls_run_off_the_async_runtime_thread() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).await.unwrap().database;
        let runtime_thread = std::thread::current().id();
        let call_thread = db.call(|_| Ok(std::thread::current().id())).await.unwrap();
        assert_ne!(call_thread, runtime_thread);
    }

    #[tokio::test]
    async fn a_fresh_database_is_migrated_to_the_current_schema() {
        let dir = tempfile::tempdir().unwrap();
        let opened = Database::open(dir.path()).await.unwrap();
        assert_eq!(opened.migrations_applied, MIGRATIONS.len());
        assert_eq!(
            opened.database.schema_version().await.unwrap(),
            SCHEMA_VERSION
        );
    }
}
