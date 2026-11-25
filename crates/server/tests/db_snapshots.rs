//! Migration snapshots and refusing a newer database (#61).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use openstar::db::{self, DATABASE_FILE, SCHEMA_VERSION};
use openstar::{BUILD_ID, Config, Server};
use openstar_test_harness::{AppFolders, TestApp};
use rusqlite::Connection;

fn backups(appdata: &Path) -> PathBuf {
    appdata.join("backups")
}

/// The file names in `backups/`, sorted; none when the folder is missing.
fn snapshot_names(appdata: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(backups(appdata)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

fn user_version(conn: &Connection) -> u32 {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

fn last_build(conn: &Connection) -> String {
    conn.query_row(
        "SELECT value FROM server_meta WHERE key = 'last_build'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// Writes `backups/<name>` with a modification time `age` in the past.
fn old_snapshot(appdata: &Path, name: &str, age: Duration) {
    fs::create_dir_all(backups(appdata)).unwrap();
    let path = backups(appdata).join(name);
    fs::write(&path, b"an older snapshot").unwrap();
    let file = fs::File::options().write(true).open(&path).unwrap();
    file.set_modified(SystemTime::now() - age).unwrap();
}

#[tokio::test]
async fn an_older_schema_is_snapshotted_before_it_is_migrated() {
    let folders = AppFolders::new();
    let appdata = folders.appdata_dir().to_owned();
    let old = SCHEMA_VERSION - 1;
    db::create_at_schema(&appdata, old, "1.2.3").unwrap();

    // Another connection keeps a row in the write-ahead log only, so a plain
    // file copy would miss it: the snapshot must still hold it.
    let writer = Connection::open(appdata.join(DATABASE_FILE)).unwrap();
    writer
        .execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
             INSERT INTO server_meta (key, value) VALUES ('test:marker', 'in the log');",
        )
        .unwrap();

    let app = TestApp::builder().folders(folders).start().await;
    drop(writer);

    assert_eq!(snapshot_names(&appdata), vec!["openstar-1.2.3.db"]);
    let snapshot = Connection::open(backups(&appdata).join("openstar-1.2.3.db")).unwrap();
    let integrity: String = snapshot
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
    assert_eq!(user_version(&snapshot), old);
    assert_eq!(last_build(&snapshot), "1.2.3");
    let marker: String = snapshot
        .query_row(
            "SELECT value FROM server_meta WHERE key = 'test:marker'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(marker, "in the log");

    assert_eq!(app.migrations_applied(), 1);
    let live = Connection::open(appdata.join(DATABASE_FILE)).unwrap();
    assert_eq!(user_version(&live), SCHEMA_VERSION);
    assert_eq!(last_build(&live), BUILD_ID);
}

#[tokio::test]
async fn only_the_three_newest_snapshots_are_kept() {
    let folders = AppFolders::new();
    let appdata = folders.appdata_dir().to_owned();
    db::create_at_schema(&appdata, SCHEMA_VERSION - 1, "0.4.0").unwrap();
    old_snapshot(&appdata, "openstar-0.1.0.db", Duration::from_secs(3_000));
    old_snapshot(&appdata, "openstar-0.2.0.db", Duration::from_secs(2_000));
    old_snapshot(&appdata, "openstar-0.3.0.db", Duration::from_secs(1_000));
    old_snapshot(&appdata, "notes.txt", Duration::from_secs(9_000));

    let _app = TestApp::builder().folders(folders).start().await;

    assert_eq!(
        snapshot_names(&appdata),
        vec![
            "notes.txt",
            "openstar-0.2.0.db",
            "openstar-0.3.0.db",
            "openstar-0.4.0.db"
        ]
    );
}

#[tokio::test]
async fn a_database_at_the_current_schema_gets_no_snapshot() {
    let app = TestApp::start().await;
    let appdata = app.appdata_dir().to_owned();
    // A fresh database has nothing to snapshot either.
    assert_eq!(snapshot_names(&appdata), Vec::<String>::new());

    let folders = app.stop().await;
    let app = TestApp::builder().folders(folders).start().await;
    assert_eq!(app.migrations_applied(), 0);
    assert_eq!(snapshot_names(&appdata), Vec::<String>::new());
}

/// Makes the database in `appdata` look written by a newer OpenStar.
fn make_newer(appdata: &Path) {
    db::create_at_schema(appdata, SCHEMA_VERSION, "9.9.9").unwrap();
    let conn = Connection::open(appdata.join(DATABASE_FILE)).unwrap();
    conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
}

async fn refused_start(folders: &AppFolders) -> String {
    let config = Config::for_tests(folders.appdata_dir(), folders.songs_dir());
    match Server::start(&config).await {
        Ok(_) => panic!("OpenStar started on a newer database"),
        Err(e) => format!("{e:#}"),
    }
}

#[tokio::test]
async fn a_newer_schema_refuses_to_start_and_names_the_snapshot_to_restore() {
    let folders = AppFolders::new();
    let appdata = folders.appdata_dir().to_owned();
    make_newer(&appdata);
    // The newer OpenStar snapshotted this build's database before it migrated.
    let ours = format!("openstar-{BUILD_ID}.db");
    old_snapshot(&appdata, &ours, Duration::from_secs(2_000));
    old_snapshot(&appdata, "openstar-9.0.0.db", Duration::from_secs(1_000));
    let database = appdata.join(DATABASE_FILE);
    let before = fs::read(&database).unwrap();

    let message = refused_start(&folders).await;

    assert!(message.contains("newer"), "{message}");
    assert!(message.contains("9.9.9"), "{message}");
    let restore = backups(&appdata).join(&ours);
    assert!(
        message.contains(&restore.display().to_string()),
        "{message}"
    );
    assert_eq!(fs::read(&database).unwrap(), before, "the database changed");
    let conn = Connection::open(&database).unwrap();
    assert_eq!(user_version(&conn), SCHEMA_VERSION + 1);
    assert_eq!(last_build(&conn), "9.9.9");
}

#[tokio::test]
async fn a_newer_schema_names_the_newest_snapshot_when_none_is_from_this_build() {
    let folders = AppFolders::new();
    let appdata = folders.appdata_dir().to_owned();
    make_newer(&appdata);
    old_snapshot(&appdata, "openstar-8.0.0.db", Duration::from_secs(2_000));
    old_snapshot(&appdata, "openstar-9.0.0.db", Duration::from_secs(1_000));

    let message = refused_start(&folders).await;

    let newest = backups(&appdata).join("openstar-9.0.0.db");
    assert!(message.contains(&newest.display().to_string()), "{message}");
}

#[tokio::test]
async fn a_newer_schema_without_snapshots_still_refuses_to_start() {
    let folders = AppFolders::new();
    make_newer(folders.appdata_dir());

    let message = refused_start(&folders).await;

    assert!(message.contains("no snapshot"), "{message}");
}
