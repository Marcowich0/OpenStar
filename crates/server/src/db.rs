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
    // 12: Guests. A member is a Profile (`profile_id` set, the guest columns
    // NULL) or a Guest (`profile_id` NULL, its name, avatar and Difficulty
    // here). A Guest goes with its Party like every member. Unique Guest
    // names (ignoring case) are kept by the live-state task.
    "ALTER TABLE party_members ADD COLUMN guest_name TEXT;
     ALTER TABLE party_members ADD COLUMN guest_avatar_kind TEXT;
     ALTER TABLE party_members ADD COLUMN guest_avatar_ref TEXT;
     ALTER TABLE party_members ADD COLUMN guest_difficulty TEXT;",
    // 13: the filter fields of the Song list (see `library::search`):
    // `#YEAR`, and the list headers split on commas, as JSON lists of
    // strings; all NULL for a rejected `.txt`. Rows already indexed are
    // filled from their stored Song, so no re-read is needed.
    "ALTER TABLE library_files ADD COLUMN year INTEGER;
     ALTER TABLE library_files ADD COLUMN languages TEXT;
     ALTER TABLE library_files ADD COLUMN genres TEXT;
     ALTER TABLE library_files ADD COLUMN editions TEXT;
     ALTER TABLE library_files ADD COLUMN creators TEXT;
     UPDATE library_files SET
         year = json_extract(song, '$.headers.year'),
         languages = json_extract(song, '$.headers.languages'),
         genres = json_extract(song, '$.headers.genres'),
         editions = json_extract(song, '$.headers.editions'),
         creators = json_extract(song, '$.headers.creators')
     WHERE song IS NOT NULL;",
    // 14: rounds, Score records and Note snapshots (see `scores`). Songs are
    // their identity key (`library::identity::key`), never a Library row, so
    // records outlive a Song leaving the Library. A record is a Profile's
    // (`profile_id`, deleted with it) or a Guest's (`guest_name`). Nothing
    // limits records per round or per Profile: the seat count and "a Profile
    // at most once in a Line-up" are Line-up rules, never constraints here.
    // `beat_values` is one byte per Beat (0 no voice, 1 voice without pitch,
    // 2 pitch) followed, for a pitch, by its f64 in little-endian. A Note
    // snapshot is the JSON its fingerprint hashes, stored once.
    "CREATE TABLE rounds (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        song_identity TEXT NOT NULL,
        party_id      TEXT NOT NULL,
        mode          TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        ended         TEXT NOT NULL CHECK (ended IN ('played', 'ended', 'skipped')),
        game_id       TEXT
    ) STRICT;
    CREATE INDEX rounds_song ON rounds (song_identity);
    CREATE TABLE note_snapshots (
        fingerprint TEXT PRIMARY KEY NOT NULL,
        snapshot    TEXT NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE score_records (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id         INTEGER NOT NULL REFERENCES rounds(id),
        party_id         TEXT NOT NULL,
        song_identity    TEXT NOT NULL,
        profile_id       INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
        guest_name       TEXT,
        voice            INTEGER NOT NULL,
        difficulty       TEXT NOT NULL,
        recorded_at_ms   INTEGER NOT NULL,
        total            INTEGER NOT NULL,
        notes            INTEGER NOT NULL,
        golden           INTEGER NOT NULL,
        line_bonus       INTEGER NOT NULL,
        mic_kind         TEXT NOT NULL,
        mode             TEXT NOT NULL,
        unfinished       INTEGER NOT NULL,
        mic_lost         INTEGER NOT NULL,
        first_beat       INTEGER NOT NULL,
        last_beat        INTEGER NOT NULL,
        note_fingerprint TEXT NOT NULL REFERENCES note_snapshots(fingerprint),
        beat_values      BLOB NOT NULL,
        CHECK ((profile_id IS NULL) <> (guest_name IS NULL))
    ) STRICT;
    CREATE INDEX score_records_round ON score_records (round_id);
    CREATE INDEX score_records_song ON score_records (song_identity);
    CREATE INDEX score_records_profile ON score_records (profile_id);",
    // 15: the head's waiting Line-up (one per Party, gone with its Request
    // or its Party) and its seats in seat order, and the Local mic each
    // member last sang on in the Party. "A member at most once in a
    // Line-up", one Mic per seat and the seat count (`SEATS`) are rules of
    // the live-state task, never constraints here. `mic_kind` / `mic_id` are
    // both NULL for a seat without a Mic.
    "CREATE TABLE line_ups (
        party_id   TEXT PRIMARY KEY REFERENCES parties(id) ON DELETE CASCADE,
        request_id INTEGER NOT NULL REFERENCES queue_requests(id) ON DELETE CASCADE,
        duet       INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE line_up_seats (
        party_id   TEXT NOT NULL REFERENCES line_ups(party_id) ON DELETE CASCADE,
        seat       INTEGER NOT NULL,
        member_id  INTEGER NOT NULL,
        mic_kind   TEXT CHECK (mic_kind IN ('phone', 'localMic')),
        mic_id     TEXT,
        voice      TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        PRIMARY KEY (party_id, seat)
    ) STRICT;
    CREATE TABLE last_local_mics (
        party_id     TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        member_id    INTEGER NOT NULL,
        local_mic_id TEXT NOT NULL,
        PRIMARY KEY (party_id, member_id)
    ) STRICT;",
    // 16: media conversions into `/appdata/cache/media/<id>.mp4` (see
    // `library::conversion`), one per Library media file the Stage cannot
    // play, keyed by its path (relative to the Library), size and mtime: a
    // changed source gets a new row and a new file. `job_id` is the job that
    // converts it. On `library_files`, `preparing` (audio converting) and
    // `conversion_problems` (JSON list like `file_problems`) follow the
    // conversions of the row's audio and video.
    "CREATE TABLE media_conversions (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        path     TEXT NOT NULL UNIQUE,
        size     INTEGER NOT NULL,
        mtime_ns INTEGER NOT NULL,
        state    TEXT NOT NULL CHECK (state IN ('converting', 'done', 'failed')),
        job_id   INTEGER
    ) STRICT;
    ALTER TABLE library_files ADD COLUMN preparing INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE library_files ADD COLUMN conversion_problems TEXT NOT NULL DEFAULT '[]';",
    // 17: Local mics (see `local_mics`): name (empty shows the default) and
    // whether switched on, by Local mic id. `source` is the JSON of
    // `LocalMicSource`. Not linked to `parties`, so New party keeps them.
    "CREATE TABLE local_mics (
        id          TEXT PRIMARY KEY NOT NULL,
        source      TEXT NOT NULL,
        name        TEXT NOT NULL,
        switched_on INTEGER NOT NULL CHECK (switched_on IN (0, 1))
    ) STRICT;",
    // 18: the results a Party shows (see `live::store`): the Song that just
    // ended and how, kept until Next or Done. Its Request has left
    // `queue_requests`, so `request_id` references nothing.
    "CREATE TABLE party_results (
        party_id   TEXT PRIMARY KEY REFERENCES parties(id) ON DELETE CASCADE,
        request_id INTEGER NOT NULL,
        song_id    INTEGER NOT NULL,
        ended      TEXT NOT NULL CHECK (ended IN ('played', 'ended'))
    ) STRICT;",
    // 19: each Song's loudness (see `library::loudness`): EBU R128
    // integrated loudness in LUFS of an audio file (path relative to the
    // Library), valid while its probed size and mtime are unchanged. `lufs`
    // is NULL when the file was measured without a result.
    "CREATE TABLE media_loudness (
        path     TEXT PRIMARY KEY,
        size     INTEGER NOT NULL,
        mtime_ns INTEGER NOT NULL,
        lufs     REAL
    ) STRICT, WITHOUT ROWID;",
    // 20: what is kept per (Stage browser, Stage output) (see
    // `stage_outputs`): the OpenStar volume, 0 to 100. Not linked to
    // `parties`, so New party keeps it. The A/V offset (#161) belongs here
    // too.
    "CREATE TABLE stage_outputs (
        stage_browser TEXT NOT NULL,
        stage_output  TEXT NOT NULL,
        volume        INTEGER NOT NULL CHECK (volume BETWEEN 0 AND 100),
        PRIMARY KEY (stage_browser, stage_output)
    ) STRICT, WITHOUT ROWID;",
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

    #[test]
    fn the_filter_fields_of_songs_indexed_before_them_are_filled_in() {
        let mut conn = Connection::open_in_memory().unwrap();
        let adds_them = MIGRATIONS
            .iter()
            .position(|m| m.contains("ADD COLUMN year"))
            .unwrap();
        for sql in &MIGRATIONS[..adds_them] {
            conn.execute_batch(sql).unwrap();
        }
        let song = r#"{"headers":{"year":1999,"languages":["English","German"],
            "genres":["Pop"],"editions":[],"creators":["alice"]}}"#;
        conn.execute(
            "INSERT INTO library_files (path, size, mtime_ns, parser_version, song, duet,
                 txt_problems, file_references)
             VALUES ('a/song.txt', 1, 1, 1, ?1, 0, '[]', '[]'),
                    ('b/song.txt', 1, 1, 1, NULL, 0, '[]', '[]')",
            [song],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", adds_them as i64)
            .unwrap();
        migrate(&mut conn).unwrap();

        let row = |path: &str| {
            conn.query_row(
                "SELECT year, languages, genres, editions, creators FROM library_files
                 WHERE path = ?1",
                [path],
                |r| {
                    Ok((
                        r.get::<_, Option<i32>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .unwrap()
        };
        assert_eq!(
            row("a/song.txt"),
            (
                Some(1999),
                Some(r#"["English","German"]"#.into()),
                Some(r#"["Pop"]"#.into()),
                Some("[]".into()),
                Some(r#"["alice"]"#.into()),
            )
        );
        assert_eq!(row("b/song.txt"), (None, None, None, None, None));
    }
}
