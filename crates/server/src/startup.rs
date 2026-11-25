//! The startup checks on the two volumes.
//!
//! [`crate::Server::start`] runs the steps in the spec's order:
//! configuration (already read), the appdata check, the database, the songs
//! check, then reloading live state. Nothing is served before it returns.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use anyhow::bail;
use openstar_protocol::{LibraryReadOnly, LibraryReadOnlyCode};

/// Step 2: refuses to go on unless OpenStar can write to the appdata folder.
pub fn check_appdata(dir: &Path) -> anyhow::Result<()> {
    if !dir.is_dir() {
        bail!(
            "the appdata folder {} does not exist: mount a writable volume there (or set OPENSTAR_APPDATA_DIR)",
            dir.display()
        );
    }
    if let Err(error) = probe_write(dir) {
        bail!(
            "the appdata folder {} cannot be written to ({error}): give the user OpenStar runs as write access to it",
            dir.display()
        );
    }
    tracing::info!(dir = %dir.display(), "the appdata folder is writable");
    Ok(())
}

/// Step 4: works out whether the Library is read-only. Never fails: a songs
/// folder OpenStar cannot write to still plays.
pub fn check_songs(dir: &Path) -> Option<LibraryReadOnly> {
    let code = if !dir.is_dir() {
        LibraryReadOnlyCode::SongsFolderMissing
    } else if let Err(error) = probe_write(dir) {
        tracing::debug!(%error, "the songs folder write check failed");
        LibraryReadOnlyCode::SongsFolderNotWritable
    } else {
        tracing::info!(dir = %dir.display(), "the songs folder is writable");
        return None;
    };
    tracing::warn!(
        dir = %dir.display(),
        ?code,
        "the Library is read-only: Downloads, Timing edits and deletes are disabled"
    );
    Some(LibraryReadOnly {
        code,
        songs_dir: dir.display().to_string(),
    })
}

/// Writes and removes a small file in `dir`.
fn probe_write(dir: &Path) -> std::io::Result<()> {
    let path = dir.join(format!(".openstar-write-check-{}", std::process::id()));
    let written = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .and_then(|mut file| file.write_all(b"ok").and_then(|()| file.sync_all()));
    let removed = std::fs::remove_file(&path);
    written.and(removed)
}
