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
    // 5: background jobs. `params` is the job's kind and parameters as JSON,
    // `error` the failure's `UserMessage` as JSON.
    "CREATE TABLE jobs (
        id     INTEGER PRIMARY KEY,
        params TEXT NOT NULL,
        state  TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
        error  TEXT
    ) STRICT;",
    // 6: the Library index, one row per candidate `.txt` (see `library::index`).
    // Paths are relative to the Library with `/` between folders; problem and
    // reference lists are JSON; `*_path` are the resolved file references.
    "CREATE TABLE library_files (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        path              TEXT NOT NULL UNIQUE,
        size              INTEGER NOT NULL,
        mtime_ns          INTEGER NOT NULL,
        parser_version    INTEGER NOT NULL,
        encoding          TEXT,
        song              TEXT,
        artist            TEXT,
        title             TEXT,
        duet              INTEGER NOT NULL,
        txt_problems      TEXT NOT NULL,
        file_references   TEXT NOT NULL,
        file_problems     TEXT NOT NULL DEFAULT '[]',
        playable          INTEGER NOT NULL DEFAULT 0,
        audio_path        TEXT,
        video_path        TEXT,
        cover_path        TEXT,
        background_path   TEXT,
        vocals_path       TEXT,
        instrumental_path TEXT
    ) STRICT;",
    // 7: Mic delays, bleed levels and Mic thresholds per (Mic, Stage
    // output), kept across Parties (no link to `parties`). A Mic is a Phone
    // id or a Local mic id. Calibration writes the delay and bleed level
    // together; a hand setting writes only the threshold, so a
    // never-calibrated Local mic has a threshold and no delay. dBFS values
    // are at the reference volume.
    "CREATE TABLE mic_settings (
        mic_kind         TEXT NOT NULL CHECK (mic_kind IN ('phone', 'localMic')),
        mic_id           TEXT NOT NULL,
        stage_output     TEXT NOT NULL,
        mic_delay_ms     REAL,
        bleed_level_dbfs REAL,
        threshold_dbfs   REAL,
        threshold_set_by TEXT CHECK (threshold_set_by IN ('calibration', 'hand')),
        PRIMARY KEY (mic_kind, mic_id, stage_output),
        CHECK ((mic_delay_ms IS NULL) = (bleed_level_dbfs IS NULL)),
        CHECK ((threshold_dbfs IS NULL) = (threshold_set_by IS NULL))
    ) STRICT, WITHOUT ROWID;",
    // 8: the current Party's members and joined Phones. Both go with their
    // Party (New party deletes the `parties` row), and a member's Phones go
    // with the member. One holder per colour and one membership per Profile
    // are kept by the live-state task and backed by UNIQUE here. A member is
    // a Profile for now; Guests add their columns later.
    "CREATE TABLE party_members (
        party_id        TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        member_id       INTEGER NOT NULL,
        profile_id      INTEGER REFERENCES profiles(id),
        colour          TEXT NOT NULL,
        favourite_taken INTEGER NOT NULL,
        PRIMARY KEY (party_id, member_id),
        UNIQUE (party_id, colour),
        UNIQUE (party_id, profile_id)
    ) STRICT;
    CREATE TABLE joined_phones (
        party_id  TEXT NOT NULL,
        phone_id  TEXT NOT NULL,
        member_id INTEGER NOT NULL,
        PRIMARY KEY (party_id, phone_id),
        FOREIGN KEY (party_id, member_id)
            REFERENCES party_members(party_id, member_id) ON DELETE CASCADE
    ) STRICT;",
    // 9: Song identity (see `library::identity`). `usdb_id` is `apiId` from
    // the `metadata.json` beside the `.txt`; `identity` is the identity as
    // JSON, NULL for a rejected `.txt`. Both are set again at every scan.
    "ALTER TABLE library_files ADD COLUMN usdb_id INTEGER;
     ALTER TABLE library_files ADD COLUMN identity TEXT;
     CREATE INDEX library_files_identity ON library_files (identity);
     CREATE INDEX library_files_usdb_id ON library_files (usdb_id);",
    // 10: the current Party's Queue, one row per Request, ordered by
    // `position`. Requests go with their Party (New party clears the Queue).
    // AUTOINCREMENT: a Request id is never reused. `requested_players` is a
    // JSON list of member ids; its length limit (`SEATS`) is kept by the
    // live-state task, never by a CHECK. `adder` is NULL for the Stage.
    // `song_id` has no foreign key: a Song leaving the Library drops its
    // Requests with a notice, not silently by cascade.
    "CREATE TABLE queue_requests (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        party_id          TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        position          INTEGER NOT NULL,
        kind              TEXT NOT NULL,
        song_id           INTEGER NOT NULL,
        requested_players TEXT NOT NULL,
        adder             INTEGER
    ) STRICT;
    CREATE INDEX queue_requests_party ON queue_requests (party_id, position);",
    // 11: Song media (see `library::probe`). `media_probes` keeps ffprobe's
    // answer per audio or video file (path relative to the Library), valid
    // while its size and mtime are unchanged; `container` is NULL when
    // ffprobe could not read the file. From here on `cover_path` and
    // `background_path` of `library_files` are the chosen cover and
    // background (by the fallback rules), not the header references;
    // `length_seconds` is `#END` or the audio's duration.
    "CREATE TABLE media_probes (
        path             TEXT PRIMARY KEY,
        size             INTEGER NOT NULL,
        mtime_ns         INTEGER NOT NULL,
        container        TEXT,
        audio_codec      TEXT,
        video_codec      TEXT,
        duration_seconds REAL,
        native           INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID;
     ALTER TABLE library_files ADD COLUMN length_seconds REAL;
     ALTER TABLE library_files ADD COLUMN has_video INTEGER NOT NULL DEFAULT 0;",
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
