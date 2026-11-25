//! The scan's probing pass, after the `.txt` files are read and their
//! references resolved.
//!
//! Every audio and video file a parsed `.txt` names is probed with ffprobe,
//! unless it was probed at its current size and mtime. Answers for files no
//! `.txt` names any more are dropped. Then each Song's length and whether it
//! has video are set from the probes.
//!
//! ffprobe runs as a child process through the job runner's helper
//! ([`Slot::command`]), one at a time, with the settings' `PATH`; it is killed
//! when the scan is cancelled, and given up on after [`PROBE_TIMEOUT`].

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use openstar_protocol::UserMessage;
use rusqlite::{Connection, params};

use super::probe::Probe;
use crate::db::Database;
use crate::jobs::Slot;

/// How long one ffprobe may take before the file counts as unreadable.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// A media file as it is on disk now.
struct OnDisk {
    path: String,
    size: i64,
    mtime_ns: i64,
}

/// Probes what needs probing and updates every Song's length and has video.
/// Returns how many files were probed, or `None` when the scan was cancelled.
pub(crate) async fn run(
    db: &Database,
    root: &Path,
    slot: &Slot,
    cancelled: &Arc<AtomicBool>,
) -> anyhow::Result<Option<u32>> {
    let (named, probed) = db
        .call(|conn| Ok::<_, rusqlite::Error>((named_media(conn)?, probed_media(conn)?)))
        .await?;
    let stat_root = root.to_owned();
    let on_disk = tokio::task::spawn_blocking(move || {
        named
            .into_iter()
            .filter_map(|path| {
                let metadata = std::fs::metadata(stat_root.join(&path)).ok()?;
                Some(OnDisk {
                    path,
                    size: i64::try_from(metadata.len()).unwrap_or(i64::MAX),
                    mtime_ns: super::scan::mtime_ns(&metadata),
                })
            })
            .collect::<Vec<_>>()
    })
    .await?;

    let keep: Vec<String> = on_disk.iter().map(|f| f.path.clone()).collect();
    let mut count = 0u32;
    for file in on_disk {
        if probed.get(&file.path) == Some(&(file.size, file.mtime_ns)) {
            continue;
        }
        if cancelled.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let probe = match ffprobe(slot, &root.join(&file.path)).await {
            Ok(probe) => probe,
            Err(UserMessage::ToolNotFound { tool }) => {
                tracing::warn!(%tool, "ffprobe was not found: Song media stays unprobed");
                break;
            }
            Err(UserMessage::JobCancelled) => return Ok(None),
            Err(reason) => {
                tracing::warn!(path = %file.path, ?reason, "probing a media file");
                continue;
            }
        };
        db.call(move |conn| store(conn, &file, &probe)).await?;
        count += 1;
    }
    if cancelled.load(Ordering::Relaxed) {
        return Ok(None);
    }
    db.call(move |conn| {
        let tx = conn.transaction()?;
        forget_others(&tx, &keep)?;
        derive_song_fields(&tx)?;
        tx.commit()
    })
    .await?;
    Ok(Some(count))
}

/// Runs ffprobe on `file`. A file ffprobe fails on, or that takes too long,
/// is unreadable; a missing ffprobe, a cancelled scan or a failure to start
/// the child are errors (nothing is stored then).
async fn ffprobe(slot: &Slot, file: &Path) -> Result<Probe, UserMessage> {
    let mut output = String::new();
    let run = slot
        .command("ffprobe")
        .arg("-v")
        .arg("error")
        .arg("-print_format")
        .arg("json")
        .arg("-show_format")
        .arg("-show_streams")
        .arg(file.as_os_str())
        .run_lines(|line| {
            output.push_str(line);
            output.push('\n');
        });
    match tokio::time::timeout(PROBE_TIMEOUT, run).await {
        Ok(Ok(())) => Ok(Probe::from_ffprobe_json(&output)),
        Ok(Err(UserMessage::ToolFailed { .. })) => Ok(Probe::unreadable()),
        Ok(Err(other)) => Err(other),
        Err(_elapsed) => {
            tracing::warn!(file = %file.display(), "ffprobe took too long");
            Ok(Probe::unreadable())
        }
    }
}

/// The audio and video files that parsed `.txt` files name.
fn named_media(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT audio_path FROM library_files WHERE song IS NOT NULL AND audio_path IS NOT NULL
         UNION
         SELECT video_path FROM library_files WHERE song IS NOT NULL AND video_path IS NOT NULL
         ORDER BY 1",
    )?;
    let rows = statement.query_map([], |row| row.get(0))?;
    rows.collect()
}

fn probed_media(conn: &Connection) -> rusqlite::Result<HashMap<String, (i64, i64)>> {
    let mut statement = conn.prepare("SELECT path, size, mtime_ns FROM media_probes")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?;
    rows.collect()
}

fn store(conn: &Connection, file: &OnDisk, probe: &Probe) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "INSERT OR REPLACE INTO media_probes
             (path, size, mtime_ns, container, audio_codec, video_codec, duration_seconds, native)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?
    .execute(params![
        file.path,
        file.size,
        file.mtime_ns,
        probe.container,
        probe.audio_codec,
        probe.video_codec,
        probe.duration_seconds,
        probe.native(),
    ])?;
    Ok(())
}

/// Drops the probes of files no `.txt` names any more (or that have gone).
fn forget_others(conn: &Connection, keep: &[String]) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TEMP TABLE IF NOT EXISTS keep_media (path TEXT PRIMARY KEY); DELETE FROM keep_media;")?;
    let mut insert = conn.prepare_cached("INSERT OR IGNORE INTO keep_media (path) VALUES (?1)")?;
    for path in keep {
        insert.execute([path])?;
    }
    conn.execute_batch(
        "DELETE FROM media_probes WHERE path NOT IN (SELECT path FROM keep_media);
         DELETE FROM keep_media;",
    )
}

/// Length: `#END` when it is set, else the audio's duration. Has video: a
/// `#VIDEO` file that, once probed, turned out to hold a video stream (a
/// file ffprobe could not read counts, since its conversion decides).
fn derive_song_fields(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "UPDATE library_files SET
             length_seconds = CASE WHEN song IS NULL THEN NULL ELSE COALESCE(
                 json_extract(song, '$.headers.endSeconds'),
                 (SELECT duration_seconds FROM media_probes p WHERE p.path = audio_path)) END,
             has_video = video_path IS NOT NULL AND COALESCE(
                 (SELECT container IS NULL OR video_codec IS NOT NULL
                  FROM media_probes p WHERE p.path = video_path), 1);",
    )
}
