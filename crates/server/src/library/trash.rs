//! Deleting a Song to the trash (`DELETE /api/songs/{id}`, guarded, writes
//! the Library).
//!
//! The Song's whole folder (the one holding its `.txt`) is moved to
//! `/appdata/trash/<n>`, never to a folder inside the Library: UltraStar
//! Deluxe finds `.txt` files at any depth, so a hidden trash there would
//! bring the Song back. Across filesystems the move is a copy, then a
//! delete. The trash ledger (table `trash`) records the folder's original
//! path and the time of deletion; restoring and the 30-day purge are #191's.
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

use super::{index, publish, scan};
use crate::AppState;

/// The trash, relative to `/appdata`.
const TRASH_DIR: &str = "trash";

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
    if let Err(error) = publish::copy_in(folder, target) {
        let _ = std::fs::remove_dir(target);
        return Err(error);
    }
    std::fs::remove_dir_all(folder)
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
    fn a_txt_in_the_library_root_has_no_folder() {
        assert_eq!(song_folder("loose.txt"), None);
        assert_eq!(song_folder("A - B/song.txt"), Some("A - B"));
        assert_eq!(song_folder("Old/A - B/song.txt"), Some("Old/A - B"));
    }
}
