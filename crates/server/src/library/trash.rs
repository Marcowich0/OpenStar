//! Deleting a Song to the trash (`DELETE /api/songs/{id}`, guarded, writes
//! the Library).
//!
//! The Song's whole folder (the one holding its `.txt`) is moved to
//! `/appdata/trash/<n>`, never to a folder inside the Library: UltraStar
//! Deluxe finds `.txt` files at any depth, so a hidden trash there would
//! bring the Song back. Across filesystems the move is a copy, then a
//! delete. The trash ledger (table `trash`) records the folder's original
//! path and the time of deletion.
//!
//! `GET /api/library/trash` lists the trash. `POST
//! /api/library/trash/{id}/restore` (guarded, writes the Library) moves a
//! trashed folder back to its original path and applies it straight to the
//! index, unless a folder of that name exists there now (`409
//! restoreFolderExists`, nothing written: OpenStar never writes into an
//! existing folder). A trashed folder and its ledger row are deleted for good
//! [`KEPT_FOR_MS`] after the delete, by [`purge`], which runs at start and
//! daily ([`purge_daily`]).
//!
//! The ledger row is written before the move, so after a crash a row may
//! name a `trash/<id>` that is not there. Such a row is not listed, a
//! restore of it drops it (`404 notInTrash`), and the next purge drops it.
//!
//! Refused, with nothing moved:
//! - `409 songPlaying` while the Song plays on the Stage;
//! - `409 songFolderShared` when the folder also holds another `.txt` (at
//!   any depth: another Song, a rejected file or a duplicate), which the
//!   move would take with it;
//! - `409 songInLibraryRoot` when the `.txt` sits directly in the Library
//!   root, which has no folder of its own to move;
//! - `404 songNotInLibrary` when the index has no parsed `.txt` of that id.
//!
//! After the move the folder's rows leave the index straight away (no
//! scan), the Party is told the Song left the Library (its queued Requests
//! drop, each with a toast event), and every browser gets a
//! [`ChangeTopic::Library`] notice. Score records are not touched: they stay,
//! hidden, until a Song with the same identity is back. A delete holds the
//! scanner's `index_writes` lock, like scans, saves and restores.

use std::io;
use std::path::Path;

use axum::Json;
use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::library::SongId;
use openstar_protocol::{ChangeTopic, UserMessage};
use rusqlite::OptionalExtension as _;

use openstar_protocol::library::{TrashId, TrashList, TrashedSong};

use super::{Scanner, index, publish, scan};
use crate::AppState;
use crate::clock::Clock;

/// The trash, relative to `/appdata`.
const TRASH_DIR: &str = "trash";

/// How long a trashed folder is kept: 30 days, in ms.
pub(crate) const KEPT_FOR_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// How often [`purge_daily`] purges after the one at start.
const PURGE_EVERY: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

#[derive(Debug)]
enum Refused {
    NotFound,
    Playing,
    InLibraryRoot,
    FolderShared(String),
    Failed(anyhow::Error),
}

impl<E: Into<anyhow::Error>> From<E> for Refused {
    fn from(error: E) -> Self {
        Self::Failed(error.into())
    }
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::NotFound => (StatusCode::NOT_FOUND, UserMessage::SongNotInLibrary),
            Self::Playing => (StatusCode::CONFLICT, UserMessage::SongPlaying),
            Self::InLibraryRoot => (StatusCode::CONFLICT, UserMessage::SongInLibraryRoot),
            Self::FolderShared(other_txt) => (
                StatusCode::CONFLICT,
                UserMessage::SongFolderShared { other_txt },
            ),
            Self::Failed(error) => {
                tracing::error!(?error, "deleting a Song to the trash");
                (StatusCode::INTERNAL_SERVER_ERROR, UserMessage::ServerError)
            }
        };
        (status, Json(message)).into_response()
    }
}

/// How a folder leaves the Library.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Move {
    /// A rename, or a copy then a delete across filesystems.
    Rename,
    /// Always a copy, then a delete (what a rename falls back to).
    #[cfg_attr(not(test), expect(dead_code))]
    Copy,
}

/// Copies `folder` into the empty folder `target` and then deletes
/// `folder`; a failed copy removes what it copied and `target`, and leaves
/// `folder` as it was.
fn copy_then_delete(folder: &Path, target: &Path) -> io::Result<()> {
    if let Err(error) = publish::copy_in(folder, target) {
        let _ = std::fs::remove_dir(target);
        return Err(error);
    }
    std::fs::remove_dir_all(folder)
}

/// Moves `folder` onto `claimed`, an empty folder the caller just made (so
/// nobody else writes there): a rename replaces it, and across filesystems
/// the files are copied into it, then `folder` is deleted. A failed copy
/// removes `claimed` too. Blocks on the filesystem.
fn move_onto_claimed(folder: &Path, claimed: &Path, how: Move) -> io::Result<()> {
    if how == Move::Rename {
        match std::fs::rename(folder, claimed) {
            Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {}
            other => return other,
        }
    }
    copy_then_delete(folder, claimed)
}

/// Moves `folder` to `target`, which must not exist. Across filesystems the
/// files are copied into a new `target` and `folder` is deleted after the
/// whole copy succeeded; a failed copy removes what it copied and leaves
/// `folder` as it was. Blocks on the filesystem.
fn move_out(folder: &Path, target: &Path, how: Move) -> io::Result<()> {
    if how == Move::Rename {
        match std::fs::rename(folder, target) {
            Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {}
            other => return other,
        }
    }
    std::fs::create_dir(target)?;
    copy_then_delete(folder, target)
}

/// The folder holding the `.txt` at `path` (relative to the Library), or
/// `None` for a `.txt` in the Library root.
fn song_folder(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(folder, _)| folder)
}

/// `DELETE /api/songs/{id}`: moves the Song's folder to the trash (see the
/// module docs). `204` when done.
pub(crate) async fn delete(State(state): State<AppState>, UrlPath(id): UrlPath<u32>) -> Response {
    let id = SongId(id);
    let scanner = state.scanner.clone();
    let inner = &scanner.inner;
    let result = async {
        let _writes = inner.index_writes.lock().await;
        let loaded = inner
            .db
            .call(move |conn| index::loaded(conn, id))
            .await?
            .ok_or(Refused::NotFound)?;
        if state.live.song_playing(id).await {
            return Err(Refused::Playing);
        }
        let folder = song_folder(&loaded.path)
            .ok_or(Refused::InLibraryRoot)?
            .to_owned();
        let root = inner.songs_dir.clone();
        let (txt, checked) = (loaded.path.clone(), folder.clone());
        let other = tokio::task::spawn_blocking(move || {
            scan::txt_files(&root, &checked)
                .map(|files| files.into_iter().find(|file| *file != txt))
        })
        .await??;
        if let Some(other) = other {
            tracing::info!(path = %loaded.path, %other, "a delete refused: the folder holds another .txt");
            return Err(Refused::FolderShared(other));
        }

        // The ledger row first, so a trashed folder always has one.
        let deleted_ms = state.clock.now_millis();
        let original = folder.clone();
        let trash_id: i64 = inner
            .db
            .call(move |conn| {
                conn.query_row(
                    "INSERT INTO trash (original_path, deleted_ms) VALUES (?1, ?2) RETURNING id",
                    rusqlite::params![original, deleted_ms],
                    |row| row.get(0),
                )
            })
            .await?;
        let source = inner.songs_dir.join(&folder);
        let trash = inner.appdata_dir.join(TRASH_DIR);
        let moved = tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&trash)?;
            move_out(&source, &trash.join(trash_id.to_string()), Move::Rename)
        })
        .await?;
        if let Err(error) = moved {
            inner
                .db
                .call(move |conn| conn.execute("DELETE FROM trash WHERE id = ?1", [trash_id]))
                .await?;
            return Err(error.into());
        }
        tracing::info!(%folder, trash_id, "a Song was deleted to the trash");

        let title = inner
            .db
            .call(move |conn| {
                let tx = conn.transaction()?;
                let title: Option<String> = tx
                    .query_row(
                        "SELECT title FROM library_files WHERE id = ?1 AND playable = 1",
                        [id.0],
                        |row| row.get(0),
                    )
                    .optional()?;
                let prefix = format!("{folder}/");
                let ids: Vec<i64> = tx
                    .prepare("SELECT id FROM library_files WHERE instr(path, ?1) = 1")?
                    .query_map([prefix], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                index::remove(&tx, &ids)?;
                tx.commit()?;
                Ok::<_, rusqlite::Error>(title)
            })
            .await?;
        if let Some(title) = title {
            state.live.songs_left(vec![(id, title)]).await;
        }
        state.live.changed(vec![ChangeTopic::Library]).await;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(refused) => refused.into_response(),
    }
}

/// `trash/<id>` in `/appdata`.
fn trash_folder(state: &AppState, id: i64) -> std::path::PathBuf {
    state
        .scanner
        .inner
        .appdata_dir
        .join(TRASH_DIR)
        .join(id.to_string())
}

/// `GET /api/library/trash`: every trashed Song folder whose folder is
/// there, the most recently deleted first.
pub(crate) async fn list(State(state): State<AppState>) -> Response {
    let trash = state.scanner.inner.appdata_dir.join(TRASH_DIR);
    let result = async {
        let rows = state
            .db
            .call(|conn| {
                conn.prepare(
                    "SELECT id, original_path, deleted_ms FROM trash
                     ORDER BY deleted_ms DESC, id DESC",
                )?
                .query_map([], |row| {
                    Ok(TrashedSong {
                        id: TrashId(row.get(0)?),
                        original_path: row.get(1)?,
                        deleted_ms: row.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
            })
            .await?;
        let songs = tokio::task::spawn_blocking(move || {
            rows.into_iter()
                .filter(|song| trash.join(song.id.0.to_string()).is_dir())
                .collect::<Vec<_>>()
        })
        .await?;
        Ok::<_, anyhow::Error>(TrashList { songs })
    }
    .await;
    match result {
        Ok(list) => Json(list).into_response(),
        Err(error) => {
            tracing::error!(?error, "listing the trash");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(UserMessage::ServerError),
            )
                .into_response()
        }
    }
}

#[derive(Debug)]
enum RestoreRefused {
    NotInTrash,
    FolderExists(String),
    Failed(anyhow::Error),
}

impl<E: Into<anyhow::Error>> From<E> for RestoreRefused {
    fn from(error: E) -> Self {
        Self::Failed(error.into())
    }
}

impl IntoResponse for RestoreRefused {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::NotInTrash => (StatusCode::NOT_FOUND, UserMessage::NotInTrash),
            Self::FolderExists(path) => (
                StatusCode::CONFLICT,
                UserMessage::RestoreFolderExists { path },
            ),
            Self::Failed(error) => {
                tracing::error!(?error, "restoring a Song from the trash");
                (StatusCode::INTERNAL_SERVER_ERROR, UserMessage::ServerError)
            }
        };
        (status, Json(message)).into_response()
    }
}

/// What the filesystem part of a restore found.
enum Restored {
    Moved,
    /// The ledger row has no folder in the trash.
    Missing,
    /// A folder (or file) of that name is at the original path.
    Exists,
}

/// Moves `source` (a trashed folder) to `target`, its original path, making
/// the parent folders it needs. Blocks on the filesystem.
fn move_back(source: &Path, target: &Path) -> io::Result<Restored> {
    if !source.is_dir() {
        return Ok(Restored::Missing);
    }
    if target.symlink_metadata().is_ok() {
        return Ok(Restored::Exists);
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // The claim: from here on nobody else writes into the folder.
    match std::fs::create_dir(target) {
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Ok(Restored::Exists);
        }
        other => other?,
    }
    if let Err(error) = move_onto_claimed(source, target, Move::Rename) {
        let _ = std::fs::remove_dir(target);
        return Err(error);
    }
    Ok(Restored::Moved)
}

/// `POST /api/library/trash/{id}/restore`: moves the trashed folder back to
/// its original path and applies it straight to the index (see the module
/// docs). `204` when done.
pub(crate) async fn restore(State(state): State<AppState>, UrlPath(id): UrlPath<i64>) -> Response {
    let scanner = state.scanner.clone();
    let inner = &scanner.inner;
    let result = async {
        let _writes = inner.index_writes.lock().await;
        let original: String = inner
            .db
            .call(move |conn| {
                conn.query_row(
                    "SELECT original_path FROM trash WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()
            })
            .await?
            .ok_or(RestoreRefused::NotInTrash)?;
        let source = trash_folder(&state, id);
        let target = inner.songs_dir.join(&original);
        let restored = tokio::task::spawn_blocking(move || move_back(&source, &target)).await??;
        match restored {
            Restored::Exists => {
                tracing::info!(%original, "a restore refused: the folder exists");
                return Err(RestoreRefused::FolderExists(original));
            }
            Restored::Missing => {
                tracing::warn!(%original, id, "a trash ledger row had no folder; dropped");
                inner
                    .db
                    .call(move |conn| conn.execute("DELETE FROM trash WHERE id = ?1", [id]))
                    .await?;
                return Err(RestoreRefused::NotInTrash);
            }
            Restored::Moved => {}
        }
        tracing::info!(%original, id, "a Song was restored from the trash");
        inner
            .db
            .call(move |conn| conn.execute("DELETE FROM trash WHERE id = ?1", [id]))
            .await?;

        // Straight to the index, like a new Song folder. A failure here
        // leaves the folder in the Library; the next scan indexes it.
        let root = inner.songs_dir.clone();
        let folder = original.clone();
        let files =
            tokio::task::spawn_blocking(move || scan::read_folder(&root, &folder)).await??;
        let parser_version = inner.parser_version;
        inner
            .db
            .call(move |conn| {
                let tx = conn.transaction()?;
                index::store_read(&tx, &files, parser_version)?;
                tx.commit()
            })
            .await?;
        inner.live.changed(vec![ChangeTopic::Library]).await;
        tokio::spawn(std::sync::Arc::clone(inner).media_pass());
        Ok(())
    }
    .await;
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(refused) => refused.into_response(),
    }
}

/// Deletes for good every trashed folder deleted at least [`KEPT_FOR_MS`]
/// before `clock`'s now, with its ledger row, and drops every row whose
/// folder is missing. Holds the scanner's `index_writes` lock, so it never
/// meets a delete or a restore half done. Returns how many rows went.
pub(crate) async fn purge(scanner: &Scanner, clock: &Clock) -> anyhow::Result<usize> {
    let inner = &scanner.inner;
    let _writes = inner.index_writes.lock().await;
    let rows: Vec<(i64, i64)> = inner
        .db
        .call(|conn| {
            conn.prepare("SELECT id, deleted_ms FROM trash")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    let now = clock.now_millis();
    let trash = inner.appdata_dir.join(TRASH_DIR);
    let gone = tokio::task::spawn_blocking(move || {
        let mut gone = Vec::new();
        for (id, deleted_ms) in rows {
            let folder = trash.join(id.to_string());
            if !folder.is_dir() {
                tracing::warn!(id, "a trash ledger row had no folder; dropped");
                gone.push(id);
            } else if now.saturating_sub(deleted_ms) >= KEPT_FOR_MS {
                match std::fs::remove_dir_all(&folder) {
                    Ok(()) => {
                        tracing::info!(id, "a trashed Song folder was purged");
                        gone.push(id);
                    }
                    Err(error) => {
                        tracing::error!(id, %error, "purging a trashed Song folder");
                    }
                }
            }
        }
        gone
    })
    .await?;
    let count = gone.len();
    if count > 0 {
        inner
            .db
            .call(move |conn| {
                let tx = conn.transaction()?;
                for id in &gone {
                    tx.execute("DELETE FROM trash WHERE id = ?1", [id])?;
                }
                tx.commit()
            })
            .await?;
        inner.live.changed(vec![ChangeTopic::Library]).await;
    }
    Ok(count)
}

/// Purges now, then every day, until dropped.
pub(crate) async fn purge_daily(scanner: Scanner, clock: Clock) {
    purge_every(scanner, clock, PURGE_EVERY).await;
}

/// Purges now, then every `period`, until dropped.
async fn purge_every(scanner: Scanner, clock: Clock, period: std::time::Duration) {
    loop {
        if let Err(error) = purge(&scanner, &clock).await {
            tracing::error!(?error, "purging the trash");
        }
        tokio::time::sleep(period).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song_folder_with_files(dir: &Path) -> std::path::PathBuf {
        let folder = dir.join("songs/A - B");
        std::fs::create_dir_all(folder.join("extras")).unwrap();
        std::fs::write(folder.join("song.txt"), b"text").unwrap();
        std::fs::write(folder.join("song.mp3"), b"audio").unwrap();
        std::fs::write(folder.join("extras/notes.md"), b"notes").unwrap();
        folder
    }

    #[test]
    fn the_whole_folder_moves_out_by_rename_or_by_copy_then_delete() {
        for how in [Move::Rename, Move::Copy] {
            let dir = tempfile::tempdir().unwrap();
            let folder = song_folder_with_files(dir.path());
            let target = dir.path().join("trash-1");
            move_out(&folder, &target, how).unwrap();
            assert!(!folder.exists(), "{how:?}");
            assert!(dir.path().join("songs").is_dir(), "{how:?}");
            assert_eq!(std::fs::read(target.join("song.txt")).unwrap(), b"text");
            assert_eq!(std::fs::read(target.join("song.mp3")).unwrap(), b"audio");
            assert_eq!(
                std::fs::read(target.join("extras/notes.md")).unwrap(),
                b"notes"
            );
        }
    }

    #[test]
    fn a_copy_that_fails_leaves_the_folder_in_the_library_and_no_target() {
        let dir = tempfile::tempdir().unwrap();
        let folder = song_folder_with_files(dir.path());
        // A link to nothing cannot be copied.
        std::os::unix::fs::symlink(dir.path().join("nothing"), folder.join("z.mp3")).unwrap();
        let target = dir.path().join("trash-1");
        assert!(move_out(&folder, &target, Move::Copy).is_err());
        assert!(!target.exists());
        assert_eq!(std::fs::read(folder.join("song.txt")).unwrap(), b"text");
        assert_eq!(std::fs::read(folder.join("song.mp3")).unwrap(), b"audio");
    }

    #[test]
    fn a_folder_moves_back_onto_its_claim_by_rename_or_by_copy_then_delete() {
        for how in [Move::Rename, Move::Copy] {
            let dir = tempfile::tempdir().unwrap();
            let folder = song_folder_with_files(dir.path());
            let claimed = dir.path().join("back");
            std::fs::create_dir(&claimed).unwrap();
            move_onto_claimed(&folder, &claimed, how).unwrap();
            assert!(!folder.exists(), "{how:?}");
            assert_eq!(std::fs::read(claimed.join("song.txt")).unwrap(), b"text");
            assert_eq!(
                std::fs::read(claimed.join("extras/notes.md")).unwrap(),
                b"notes"
            );
        }
    }

    #[test]
    fn a_move_back_makes_missing_parents_and_never_writes_into_an_existing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let folder = song_folder_with_files(dir.path());
        let taken = dir.path().join("library/Taken");
        std::fs::create_dir_all(&taken).unwrap();
        assert!(matches!(
            move_back(&folder, &taken).unwrap(),
            Restored::Exists
        ));
        assert_eq!(std::fs::read_dir(&taken).unwrap().count(), 0);
        assert!(folder.join("song.txt").is_file());

        let deeper = dir.path().join("library/New/Deeper");
        assert!(matches!(
            move_back(&folder, &deeper).unwrap(),
            Restored::Moved
        ));
        assert_eq!(std::fs::read(deeper.join("song.txt")).unwrap(), b"text");
        assert!(matches!(
            move_back(&folder, &dir.path().join("library/Again")).unwrap(),
            Restored::Missing
        ));
    }

    #[tokio::test]
    async fn the_purge_runs_again_each_period() {
        let songs = tempfile::tempdir().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let scanner = crate::library::tests::scanner(songs.path(), appdata.path()).await;
        let manual = crate::clock::ManualClock::new();
        let clock = manual.clock();
        let db = scanner.inner.db.clone();
        let now = clock.now_millis();
        db.call(move |conn| {
            conn.execute(
                "INSERT INTO trash (id, original_path, deleted_ms) VALUES (1, 'A', ?1)",
                [now],
            )
        })
        .await
        .unwrap();
        std::fs::create_dir_all(appdata.path().join("trash/1")).unwrap();
        let rows = move || {
            let db = db.clone();
            async move {
                db.call(|conn| {
                    conn.query_row("SELECT count(*) FROM trash", [], |r| r.get::<_, i64>(0))
                })
                .await
                .unwrap()
            }
        };

        let task = tokio::spawn(purge_every(
            scanner.clone(),
            clock,
            std::time::Duration::from_millis(20),
        ));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(rows().await, 1_i64, "not yet 30 days");
        manual.advance(std::time::Duration::from_millis(
            u64::try_from(KEPT_FOR_MS).unwrap(),
        ));
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while rows().await != 0 {
            assert!(tokio::time::Instant::now() < deadline, "no later purge ran");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(!appdata.path().join("trash/1").exists());
        task.abort();
    }

    #[test]
    fn a_txt_in_the_library_root_has_no_folder() {
        assert_eq!(song_folder("loose.txt"), None);
        assert_eq!(song_folder("A - B/song.txt"), Some("A - B"));
        assert_eq!(song_folder("Old/A - B/song.txt"), Some("Old/A - B"));
    }
}
