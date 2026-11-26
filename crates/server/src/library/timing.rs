//! Saving a Timing edit into a Song's `.txt`, and Restore Original: the
//! only code that changes an existing file in the Library.
//!
//! - **Preview** (`POST /api/songs/{id}/timing/preview`, not guarded): the
//!   lines the edit changes, computed by the patcher that writes
//!   ([`crate::txt::write`]) from the file on disk.
//! - **Save** (`POST /api/songs/{id}/timing`, guarded, writes the Library):
//!   1. The file on disk must be the one the index loaded (same mtime and
//!      SHA-256) and the one the preview was made from (`base`); otherwise
//!      `409 songFileChanged`. The Song playing now is refused with
//!      `409 songPlaying`, and a Song that started on the Stage since the
//!      editor opened it (`openedAtMs`, the detail's `loadedAtMs`) with
//!      `409 songStartedSinceOpened`, even if it has stopped since.
//!   2. Before the Song's first edit its bytes are copied to
//!      `<name>.txt.orig` beside it. An existing Original is never
//!      overwritten.
//!   3. The new bytes go to a temporary file in the same folder, whose name
//!      does not end in `.txt` (so neither a scan nor UltraStar Deluxe ever
//!      sees it), and that is renamed over the `.txt`.
//!   4. The file is read again into the index like a scan would (no scan),
//!      keeping its row and so its [`SongId`], and every browser gets a
//!      [`ChangeTopic::Library`] notice.
//!   5. A Phone's accepted Auto-fit (`autoFitFrom` set) may only set `#GAP`
//!      and `#BPM`, and the Stage gets one `autoFitAccepted` Party change by
//!      that Phone's Party member.
//! - **Restore Original** (`POST /api/songs/{id}/restore-original`, guarded,
//!   writes the Library): the Original replaces the `.txt` the same atomic
//!   way, then the Original is deleted, so the next edit keeps a fresh one.
//!   Score records are not touched. Answers the restored file's version.
//!
//! Saves, restores and scans hold the scanner's `index_writes` lock, so they
//! never interleave.

use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Json;
use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::library::SongId;
use openstar_protocol::song::{
    ChangedLine, TimingEdit, TimingOperation, TimingPreview, TimingSave, TxtVersion,
};
use openstar_protocol::{ChangeTopic, UserMessage};

use super::{Scanner, index, scan};
use crate::AppState;
use crate::txt::{self, Operation};

impl From<TimingOperation> for Operation {
    fn from(operation: TimingOperation) -> Self {
        match operation {
            TimingOperation::SetGap { seconds } => Operation::SetGap { seconds },
            TimingOperation::SetBpm { beats_per_minute } => Operation::SetBpm { beats_per_minute },
            TimingOperation::SetVideoGap { seconds } => Operation::SetVideoGap { seconds },
            TimingOperation::SetNoteStart { line, start } => {
                Operation::SetNoteStart { line, start }
            }
            TimingOperation::SetNoteLength { line, length } => {
                Operation::SetNoteLength { line, length }
            }
            TimingOperation::SetLineEnd { line, beat } => Operation::SetLineEnd { line, beat },
        }
    }
}

/// Why a Timing edit or a restore is not done.
#[derive(Debug)]
enum Refused {
    /// No parsed `.txt` with this id is in the index.
    NotFound,
    /// The file on disk is not the one OpenStar loaded.
    FileChanged,
    /// The writer refused an operation (no such Note or Line end).
    Invalid,
    /// The Song plays on the Stage now.
    Playing,
    /// The Song started on the Stage after the editor opened it.
    StartedSinceOpened,
    /// There is no Original to restore.
    NoOriginal,
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
            Self::FileChanged => (StatusCode::CONFLICT, UserMessage::SongFileChanged),
            Self::Invalid => (
                StatusCode::UNPROCESSABLE_ENTITY,
                UserMessage::InvalidMessage,
            ),
            Self::Playing => (StatusCode::CONFLICT, UserMessage::SongPlaying),
            Self::StartedSinceOpened => (StatusCode::CONFLICT, UserMessage::SongStartedSinceOpened),
            Self::NoOriginal => (StatusCode::NOT_FOUND, UserMessage::NoOriginal),
            Self::Failed(error) => {
                tracing::error!(?error, "writing a Song's .txt");
                (StatusCode::INTERNAL_SERVER_ERROR, UserMessage::ServerError)
            }
        };
        (status, Json(message)).into_response()
    }
}

/// A Song's `.txt` read from disk and checked against the index.
struct OnDisk {
    /// Relative to the Library.
    path: String,
    /// The absolute path.
    file: PathBuf,
    bytes: Vec<u8>,
    version: TxtVersion,
    mtime_ns: i64,
    size: u64,
    parsed: txt::TxtFile,
}

/// The `.txt` of Song `id` as it is on disk, refused unless it is the file
/// the index loaded: same mtime and same content hash.
async fn load(scanner: &Scanner, id: SongId) -> Result<OnDisk, Refused> {
    let loaded = scanner
        .inner
        .db
        .call(move |conn| index::loaded(conn, id))
        .await?
        .ok_or(Refused::NotFound)?;
    let root = scanner.inner.songs_dir.clone();
    tokio::task::spawn_blocking(move || {
        let file = root.join(&loaded.path);
        let bytes = std::fs::read(&file)?;
        let metadata = std::fs::metadata(&file)?;
        let mtime_ns = scan::mtime_ns(&metadata);
        let version = TxtVersion(scan::sha256_hex(&bytes));
        if mtime_ns != loaded.mtime_ns || loaded.sha256.as_ref() != Some(&version.0) {
            tracing::info!(path = %loaded.path, "a .txt changed on disk since it was loaded");
            return Err(Refused::FileChanged);
        }
        let folder_name = Path::new(&loaded.path)
            .parent()
            .and_then(Path::file_name)
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let parsed = txt::parse(&bytes, &folder_name).map_err(|_| Refused::FileChanged)?;
        Ok(OnDisk {
            path: loaded.path,
            file,
            bytes,
            version,
            mtime_ns,
            size: metadata.len(),
            parsed,
        })
    })
    .await?
}

fn patch(on_disk: &OnDisk, operations: Vec<TimingOperation>) -> Result<txt::Written, Refused> {
    let operations: Vec<Operation> = operations.into_iter().map(Operation::from).collect();
    txt::write(&on_disk.parsed, &operations).map_err(|error| {
        tracing::info!(?error, path = %on_disk.path, "a Timing edit the writer refused");
        Refused::Invalid
    })
}

fn changed_lines(written: &txt::Written) -> Vec<ChangedLine> {
    written
        .changed
        .iter()
        .map(|c| ChangedLine {
            line: c.line,
            old: c.old.clone(),
            new: c.new.clone(),
        })
        .collect()
}

impl Scanner {
    /// Reads `path` (relative to the Library) into the index again, keeping
    /// its row, and tells every browser.
    async fn reindex(&self, path: String) -> anyhow::Result<()> {
        let root = self.inner.songs_dir.clone();
        let file = tokio::task::spawn_blocking(move || scan::read_file(&root, &path)).await??;
        let parser_version = self.inner.parser_version;
        self.inner
            .db
            .call(move |conn| {
                let tx = conn.transaction()?;
                index::store_read(&tx, std::slice::from_ref(&file), parser_version)?;
                tx.commit()
            })
            .await?;
        self.inner.live.changed(vec![ChangeTopic::Library]).await;
        Ok(())
    }
}

/// `POST /api/songs/{id}/timing/preview`: what the edit would change. Not
/// guarded; writes nothing.
pub(crate) async fn preview(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<u32>,
    Json(edit): Json<TimingEdit>,
) -> Response {
    let result = async {
        let on_disk = load(&state.scanner, SongId(id)).await?;
        let written = patch(&on_disk, edit.operations)?;
        Ok::<_, Refused>(TimingPreview {
            base: on_disk.version.clone(),
            changed: changed_lines(&written),
        })
    }
    .await;
    match result {
        Ok(preview) => Json(preview).into_response(),
        Err(refused) => refused.into_response(),
    }
}

/// `POST /api/songs/{id}/timing`: saves the edit (see the module docs) and
/// answers what was written, with the new file's version.
pub(crate) async fn save(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<u32>,
    Json(save): Json<TimingSave>,
) -> Response {
    let id = SongId(id);
    let scanner = state.scanner.clone();
    let result = async {
        let _writes = scanner.inner.index_writes.lock().await;
        let on_disk = load(&scanner, id).await?;
        if on_disk.version != save.base {
            return Err(Refused::FileChanged);
        }
        // A Phone's Auto-fit changes `#GAP` and `#BPM` only.
        if save.auto_fit_from.is_some()
            && !save.operations.iter().all(|operation| {
                matches!(
                    operation,
                    TimingOperation::SetGap { .. } | TimingOperation::SetBpm { .. }
                )
            })
        {
            return Err(Refused::Invalid);
        }
        if state.live.song_playing(id).await {
            return Err(Refused::Playing);
        }
        if let Some(opened_at_ms) = save.opened_at_ms
            && state
                .live
                .song_last_started(id)
                .await
                .is_some_and(|started_ms| started_ms >= opened_at_ms)
        {
            return Err(Refused::StartedSinceOpened);
        }
        let title = on_disk.parsed.song.headers.title.clone();
        let written = patch(&on_disk, save.operations)?;
        let changed = changed_lines(&written);
        let base = TxtVersion(scan::sha256_hex(&written.bytes));
        if !changed.is_empty() {
            let path = on_disk.path.clone();
            tokio::task::spawn_blocking(move || write_edit(&on_disk, &written.bytes)).await??;
            tracing::info!(%path, "a Timing edit was saved");
            scanner.reindex(path).await?;
        }
        if let Some(phone_id) = save.auto_fit_from {
            state.live.auto_fit_accepted(phone_id, id, title).await;
        }
        Ok(TimingPreview { base, changed })
    }
    .await;
    match result {
        Ok(saved) => Json(saved).into_response(),
        Err(refused) => refused.into_response(),
    }
}

/// Keeps the Original if there is none, then replaces the `.txt`
/// atomically, unless the file changed on disk since it was loaded.
fn write_edit(on_disk: &OnDisk, bytes: &[u8]) -> Result<(), Refused> {
    keep_original(&on_disk.file, &on_disk.bytes)?;
    let metadata = std::fs::metadata(&on_disk.file)?;
    if scan::mtime_ns(&metadata) != on_disk.mtime_ns || metadata.len() != on_disk.size {
        return Err(Refused::FileChanged);
    }
    replace_atomically(&on_disk.file, bytes)?;
    Ok(())
}

/// `POST /api/songs/{id}/restore-original`: puts the Original back and
/// deletes it. Answers the restored file's [`TxtVersion`].
pub(crate) async fn restore_original(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<u32>,
) -> Response {
    let id = SongId(id);
    let scanner = state.scanner.clone();
    let result = async {
        let _writes = scanner.inner.index_writes.lock().await;
        let loaded = scanner
            .inner
            .db
            .call(move |conn| index::loaded(conn, id))
            .await?
            .ok_or(Refused::NotFound)?;
        let file = scanner.inner.songs_dir.join(&loaded.path);
        let original = original_path(&file);
        if !tokio::fs::try_exists(&original).await? {
            return Err(Refused::NoOriginal);
        }
        if state.live.song_playing(id).await {
            return Err(Refused::Playing);
        }
        let version = tokio::task::spawn_blocking(move || {
            let bytes = std::fs::read(&original)?;
            replace_atomically(&file, &bytes)?;
            std::fs::remove_file(&original)?;
            sync_folder(&file);
            Ok::<_, std::io::Error>(TxtVersion(scan::sha256_hex(&bytes)))
        })
        .await??;
        tracing::info!(path = %loaded.path, "a Song's Original was restored");
        scanner.reindex(loaded.path).await?;
        Ok(version)
    }
    .await;
    match result {
        Ok(version) => Json(version).into_response(),
        Err(refused) => refused.into_response(),
    }
}

/// `GET /api/library/originals`: the Songs that have an Original beside
/// their `.txt`, looked up on disk.
pub(crate) async fn originals(State(state): State<AppState>) -> Response {
    let root = state.config.songs_dir.clone();
    let result = async {
        let rows = state.db.call(|conn| index::parsed_paths(conn)).await?;
        let ids = tokio::task::spawn_blocking(move || {
            rows.into_iter()
                .filter(|(_, path)| original_path(&root.join(path)).is_file())
                .map(|(id, _)| id)
                .collect::<Vec<_>>()
        })
        .await?;
        Ok::<_, anyhow::Error>(ids)
    }
    .await;
    match result {
        Ok(ids) => Json(ids).into_response(),
        Err(error) => Refused::Failed(error).into_response(),
    }
}

/// `<name>.txt.orig` beside `<name>.txt`.
fn original_path(txt: &Path) -> PathBuf {
    let mut name = txt.file_name().unwrap_or_default().to_owned();
    name.push(".orig");
    txt.with_file_name(name)
}

/// A new temporary file's path beside `txt`: `.<name>.openstar-<n>.tmp`,
/// which never ends in `.txt`, so no scan and no UltraStar program reads it.
fn temp_path(txt: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let name = txt.file_name().unwrap_or_default().to_string_lossy();
    txt.with_file_name(format!(".{name}.openstar-{}-{n}.tmp", std::process::id()))
}

/// Writes `bytes` to a new temporary file beside `txt`, flushed to disk.
/// The file is removed again if writing fails.
fn write_temp(txt: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let temp = temp_path(txt);
    let written = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    match written {
        Ok(()) => Ok(temp),
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            Err(error)
        }
    }
}

/// Copies `bytes` (the `.txt` as loaded) to `<name>.txt.orig` unless an
/// Original is there already; an existing one is never overwritten. The
/// copy is complete before it gets its name (a hard link to a finished
/// temporary file), so a crash never leaves a partial Original.
fn keep_original(txt: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let original = original_path(txt);
    if std::fs::symlink_metadata(&original).is_ok() {
        return Ok(());
    }
    let temp = write_temp(txt, bytes)?;
    let linked = std::fs::hard_link(&temp, &original);
    std::fs::remove_file(&temp)?;
    match linked {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        // A filesystem without hard links: claim the name, then write.
        Err(_) => {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&original)?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }
    }
    sync_folder(txt);
    Ok(())
}

/// Replaces `txt` with `bytes`: written to a temporary file in the same
/// folder (with the old file's permissions), then renamed over it, so the
/// `.txt` is always either the old or the new file, never half of one.
fn replace_atomically(txt: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let permissions = std::fs::metadata(txt)?.permissions();
    let temp = write_temp(txt, bytes)?;
    let renamed =
        std::fs::set_permissions(&temp, permissions).and_then(|()| std::fs::rename(&temp, txt));
    if let Err(error) = renamed {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    sync_folder(txt);
    Ok(())
}

/// Flushes the folder holding `file`, so a rename survives a power cut.
/// Best effort: not every filesystem allows it.
fn sync_folder(file: &Path) {
    if let Some(folder) = file.parent()
        && let Ok(folder) = File::open(folder)
    {
        let _ = folder.sync_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_temporary_file_is_beside_the_txt_and_never_a_txt() {
        for name in ["song.txt", "Song.TXT", "a.b.txt"] {
            let txt = Path::new("/songs/Artist - Title").join(name);
            let temp = temp_path(&txt);
            assert_eq!(temp.parent(), txt.parent());
            let temp_name = temp.file_name().unwrap().to_string_lossy().to_lowercase();
            assert!(!temp_name.ends_with(".txt"), "{temp_name}");
            assert!(!temp_name.ends_with(".txt.orig"), "{temp_name}");
            assert_ne!(temp_path(&txt), temp, "every temporary file is new");
        }
    }

    #[test]
    fn the_original_is_named_after_the_txt() {
        assert_eq!(
            original_path(Path::new("/songs/A/Song.TXT")),
            Path::new("/songs/A/Song.TXT.orig")
        );
    }

    #[test]
    fn an_existing_original_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let txt = dir.path().join("song.txt");
        std::fs::write(&txt, b"second").unwrap();
        std::fs::write(original_path(&txt), b"first").unwrap();
        keep_original(&txt, b"second").unwrap();
        assert_eq!(std::fs::read(original_path(&txt)).unwrap(), b"first");
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(names.len(), 2, "no temporary file is left");
    }

    #[test]
    fn a_failed_replace_leaves_the_txt_and_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        // The `.txt` is a folder, so the rename over it fails.
        let txt = dir.path().join("song.txt");
        std::fs::create_dir(&txt).unwrap();
        std::fs::write(txt.join("inside"), b"kept").unwrap();
        assert!(replace_atomically(&txt, b"new").is_err());
        assert_eq!(std::fs::read(txt.join("inside")).unwrap(), b"kept");
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(names.len(), 1, "the temporary file is removed");
    }
}
