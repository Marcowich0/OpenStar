//! Media the Stage cannot play, converted ahead of time into the appdata
//! cache, never into the Library.
//!
//! After probing, every audio or video file whose probe says it is not
//! native gets a row in `media_conversions` (keyed by its path, size and
//! mtime) and a [`Conversion`] job in the ffmpeg lane, which writes an
//! H.264 + AAC MP4 (an AAC MP4 for audio only) to
//! `/appdata/cache/media/<row id>.mp4`. The media endpoint serves that file
//! in place of the source once it is done ([`served`]).
//!
//! While a Song's audio (or the one file serving as audio and video)
//! converts, the Song is "preparing" and cannot be queued; while only its
//! video converts, its detail offers no video. A failed audio conversion is
//! a rejection, a failed video conversion a warning (`index::refresh`).
//!
//! The scan removes a cache entry whose source left the Library or changed
//! ([`sync`]), and the Pitch tracks in `/appdata/cache/pitch/` (`<song
//! id>.bin`, written by #57) of Songs that left or whose audio changed.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use openstar_protocol::{ChangeTopic, UserMessage};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::index::{self, Refresh};
use crate::db::Database;
use crate::jobs::{JobContext, JobParams, Jobs};

/// Converted media, below the appdata folder.
pub(crate) const MEDIA_CACHE: &str = "cache/media";
/// Pitch tracks (#57), below the appdata folder: `<song id>.bin`.
pub(crate) const PITCH_CACHE: &str = "cache/pitch";

/// The longest side limits of a converted video: at most 1080p.
const MAX_WIDTH: u32 = 1920;
const MAX_HEIGHT: u32 = 1080;

/// A conversion job: one `media_conversions` row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversion {
    /// The `media_conversions` row, which names the cache file.
    pub conversion: i64,
    /// The source file, relative to the Library.
    pub path: String,
    /// Whether the source has a video stream (attached pictures aside).
    pub video: bool,
    /// The source's duration from ffprobe, for progress.
    pub duration_ms: Option<u64>,
}

/// The converted file of conversion `id`, and the file it is written to
/// until it is complete.
fn cache_files(appdata: &Path, id: i64) -> (PathBuf, PathBuf) {
    let dir = appdata.join(MEDIA_CACHE);
    (
        dir.join(format!("{id}.mp4")),
        dir.join(format!("{id}.part.mp4")),
    )
}

/// The ffmpeg arguments that convert `source` into `output`: libx264
/// `veryfast` CRF 20, scaled down to fit 1080p keeping the aspect ratio,
/// `yuv420p`; AAC at 192 kbit/s; MP4 with `faststart`. Progress goes to
/// stdout as `key=value` lines.
fn encode_args(source: &Path, output: &Path, video: bool) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-nostdin", "-y", "-i"]
        .map(OsString::from)
        .to_vec();
    args.push(source.as_os_str().to_owned());
    let mut push = |items: &[&str]| args.extend(items.iter().map(OsString::from));
    if video {
        let scale = format!(
            "scale=w=min({MAX_WIDTH}\\,iw):h=min({MAX_HEIGHT}\\,ih)\
             :force_original_aspect_ratio=decrease:force_divisible_by=2"
        );
        push(&["-map", "0:V:0", "-map", "0:a:0?"]);
        push(&["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]);
        push(&["-vf", &scale, "-pix_fmt", "yuv420p"]);
    } else {
        push(&["-map", "0:a:0", "-vn"]);
    }
    push(&["-c:a", "aac", "-b:a", "192k"]);
    push(&["-movflags", "+faststart", "-f", "mp4"]);
    push(&["-progress", "pipe:1", "-nostats"]);
    args.push(output.as_os_str().to_owned());
    args
}

/// The percentage an ffmpeg `-progress` line says, if it says one.
fn progress_percent(line: &str, duration_ms: Option<u64>) -> Option<u8> {
    if line.trim() == "progress=end" {
        return Some(100);
    }
    let done_us: u64 = line.strip_prefix("out_time_us=")?.trim().parse().ok()?;
    let total_us = duration_ms.filter(|d| *d > 0)? * 1000;
    Some(u8::try_from((done_us * 100 / total_us).min(99)).unwrap_or(99))
}

impl Conversion {
    pub(crate) fn params(self) -> JobParams {
        JobParams::Conversion(self)
    }

    pub(crate) async fn run(self, ctx: &mut JobContext) -> Result<(), UserMessage> {
        let env = ctx.env.clone();
        let id = self.conversion;
        let state = env
            .db
            .call(move |conn| state(conn, id))
            .await
            .map_err(server_error)?;
        if state.as_deref() != Some(CONVERTING) {
            // The scan dropped it (its source left or changed) meanwhile.
            return Ok(());
        }
        let (done, part) = cache_files(&env.appdata_dir, id);
        if let Some(dir) = part.parent() {
            tokio::fs::create_dir_all(dir)
                .await
                .map_err(|e| server_error(e.into()))?;
        }
        // What an interrupted run left behind.
        let _ = tokio::fs::remove_file(&part).await;

        let source = env.songs_dir.join(&self.path);
        let mut command = ctx.slot.command("ffmpeg");
        for arg in encode_args(&source, &part, self.video) {
            command = command.arg(arg);
        }
        let progress = &ctx.progress;
        let duration_ms = self.duration_ms;
        let result = command
            .run_lines(|line| {
                if let Some(percent) = progress_percent(line, duration_ms) {
                    progress.report(percent);
                }
            })
            .await;
        let result = match result {
            Ok(()) => tokio::fs::rename(&part, &done)
                .await
                .map_err(|e| server_error(e.into())),
            Err(reason) => Err(reason),
        };
        if result.is_err() {
            let _ = tokio::fs::remove_file(&part).await;
        }
        let ended = match &result {
            Ok(()) => DONE,
            // Left converting: the next start runs it again, or the scan
            // drops it with its source.
            Err(UserMessage::JobCancelled) => return result,
            Err(reason) => {
                tracing::warn!(path = self.path, ?reason, "a media conversion failed");
                FAILED
            }
        };
        let path = self.path.clone();
        let kept = env
            .db
            .call(move |conn| {
                let tx = conn.transaction()?;
                let kept = tx.execute(
                    "UPDATE media_conversions SET state = ?2 WHERE id = ?1 AND state = 'converting'",
                    params![id, ended],
                )? == 1;
                index::refresh(&tx, &Refresh::Media(&path))?;
                tx.commit()?;
                Ok(kept)
            })
            .await
            .map_err(server_error)?;
        if !kept {
            let _ = tokio::fs::remove_file(&done).await;
        }
        env.live.changed(vec![ChangeTopic::Library]).await;
        result
    }
}

fn server_error(error: anyhow::Error) -> UserMessage {
    tracing::error!(?error, "a media conversion");
    UserMessage::ServerError
}

const CONVERTING: &str = "converting";
const DONE: &str = "done";
const FAILED: &str = "failed";

fn state(conn: &Connection, id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT state FROM media_conversions WHERE id = ?1",
        [id],
        |row| row.get(0),
    )
    .optional()
}

/// The file served for the Library media file `path` (relative to the
/// Library): its converted copy once that is done, else the file itself.
pub(crate) async fn served(
    db: &Database,
    songs_dir: &Path,
    appdata_dir: &Path,
    path: &str,
) -> anyhow::Result<PathBuf> {
    let source = path.to_owned();
    let done: Option<i64> = db
        .call(move |conn| {
            conn.query_row(
                "SELECT id FROM media_conversions WHERE path = ?1 AND state = 'done'",
                [source],
                |row| row.get(0),
            )
            .optional()
        })
        .await?;
    if let Some(id) = done {
        let (file, _) = cache_files(appdata_dir, id);
        if tokio::fs::metadata(&file).await.is_ok() {
            return Ok(file);
        }
        tracing::warn!(path, "a converted file is missing from the cache");
    }
    Ok(songs_dir.join(path))
}

/// After probing: drops the conversions whose source left the Library,
/// changed or plays natively now (their jobs are cancelled and their files
/// removed), starts one for every file that needs one, starts again any
/// whose job is no longer queued or running, updates every Song's
/// "preparing" and conversion problems, and tidies the caches. `probed`
/// are the media files probed by this scan (new or changed).
pub(crate) async fn sync(
    db: &Database,
    jobs: &Jobs,
    appdata_dir: &Path,
    probed: Vec<String>,
) -> anyhow::Result<()> {
    let (stale, to_start, pitch_keep) = db
        .call(move |conn| {
            let tx = conn.transaction()?;
            let stale = drop_stale(&tx)?;
            add_needed(&tx)?;
            let to_start = converting(&tx)?;
            index::refresh(&tx, &Refresh::All)?;
            let pitch_keep = pitch_tracks_to_keep(&tx, &probed)?;
            tx.commit()?;
            Ok((stale, to_start, pitch_keep))
        })
        .await?;

    for (id, job) in &stale {
        if let Some(job) = job {
            jobs.cancel(openstar_protocol::jobs::JobId(*job)).await;
        }
        let (done, part) = cache_files(appdata_dir, *id);
        let _ = tokio::fs::remove_file(done).await;
        let _ = tokio::fs::remove_file(part).await;
    }

    let alive: HashSet<i64> = jobs
        .list()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|job| {
            matches!(
                job.state,
                openstar_protocol::jobs::JobState::Queued
                    | openstar_protocol::jobs::JobState::Running { .. }
            )
        })
        .map(|job| job.id.0)
        .collect();
    for (conversion, job) in to_start {
        if job.is_some_and(|job| alive.contains(&job)) {
            continue;
        }
        let id = conversion.conversion;
        let job = jobs.enqueue(conversion.params()).await?;
        db.call(move |conn| {
            conn.execute(
                "UPDATE media_conversions SET job_id = ?2 WHERE id = ?1",
                params![id, job.0],
            )
        })
        .await?;
    }

    let keep: HashSet<i64> = db
        .call(|conn| {
            let mut statement =
                conn.prepare("SELECT id FROM media_conversions WHERE state != 'failed'")?;
            let rows = statement.query_map([], |row| row.get(0))?;
            rows.collect()
        })
        .await?;
    let appdata = appdata_dir.to_owned();
    tokio::task::spawn_blocking(move || {
        sweep(&appdata.join(MEDIA_CACHE), |id| keep.contains(&id), ".mp4");
        sweep(
            &appdata.join(PITCH_CACHE),
            |id| u32::try_from(id).is_ok_and(|id| pitch_keep.contains(&id)),
            ".bin",
        );
    })
    .await?;
    Ok(())
}

/// Removes every file in `dir` named `<id>.…` whose id `keep` turns down;
/// with `suffix` (`.bin`), only files named `<id><suffix>` are looked at.
fn sweep(dir: &Path, keep: impl Fn(i64) -> bool, suffix: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some((stem, rest)) = name.split_once('.') else {
            continue;
        };
        let Ok(id) = stem.parse::<i64>() else {
            continue;
        };
        if !format!(".{rest}").ends_with(suffix) || keep(id) {
            continue;
        }
        if let Err(error) = std::fs::remove_file(entry.path()) {
            tracing::warn!(%error, file = name, "removing a stale cache file");
        }
    }
}

/// Deletes the conversions whose source is no longer a probed, non-native
/// file at the same size and mtime; returns their ids and jobs.
fn drop_stale(conn: &Connection) -> rusqlite::Result<Vec<(i64, Option<i64>)>> {
    let mut statement = conn.prepare(
        "DELETE FROM media_conversions AS c WHERE NOT EXISTS (
             SELECT 1 FROM media_probes p
             WHERE p.path = c.path AND p.size = c.size AND p.mtime_ns = c.mtime_ns
                 AND NOT p.native)
         RETURNING id, job_id",
    )?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

/// A conversion for every probed file that needs one and has none.
fn add_needed(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO media_conversions (path, size, mtime_ns, state)
         SELECT path, size, mtime_ns, 'converting' FROM media_probes p
         WHERE NOT native AND NOT EXISTS (SELECT 1 FROM media_conversions c WHERE c.path = p.path)
         ORDER BY path",
        [],
    )?;
    Ok(())
}

/// Every conversion still converting, as its job, with its job's id.
fn converting(conn: &Connection) -> rusqlite::Result<Vec<(Conversion, Option<i64>)>> {
    let mut statement = conn.prepare(
        "SELECT c.id, c.path, p.video_codec IS NOT NULL, p.duration_seconds, c.job_id
         FROM media_conversions c JOIN media_probes p ON p.path = c.path
         WHERE c.state = 'converting' ORDER BY c.id",
    )?;
    let rows = statement.query_map([], |row| {
        let duration: Option<f64> = row.get(3)?;
        Ok((
            Conversion {
                conversion: row.get(0)?,
                path: row.get(1)?,
                video: row.get(2)?,
                #[expect(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "a duration in milliseconds, checked finite and not negative"
                )]
                duration_ms: duration
                    .filter(|d| d.is_finite() && *d >= 0.0)
                    .map(|d| (d * 1000.0) as u64),
            },
            row.get(4)?,
        ))
    })?;
    rows.collect()
}

/// The Songs whose Pitch track may stay: in the index with audio that this
/// scan did not find new or changed.
fn pitch_tracks_to_keep(conn: &Connection, probed: &[String]) -> rusqlite::Result<HashSet<u32>> {
    let probed: HashSet<&str> = probed.iter().map(String::as_str).collect();
    let mut statement = conn.prepare(
        "SELECT id, audio_path FROM library_files
         WHERE song IS NOT NULL AND audio_path IS NOT NULL",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut keep = HashSet::new();
    for row in rows {
        let (id, audio) = row?;
        if !probed.contains(audio.as_str()) {
            keep.insert(id);
        }
    }
    Ok(keep)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn converts_video_with_the_spec_settings() {
        let args = strings(&encode_args(
            Path::new("/songs/a.avi"),
            Path::new("/appdata/cache/media/1.part.mp4"),
            true,
        ));
        let joined = args.join(" ");
        for expected in [
            "-i /songs/a.avi",
            "-c:v libx264 -preset veryfast -crf 20",
            "-pix_fmt yuv420p",
            "-c:a aac -b:a 192k",
            "-movflags +faststart -f mp4",
            "-map 0:V:0 -map 0:a:0?",
        ] {
            assert!(joined.contains(expected), "{expected} in {joined}");
        }
        let scale = &args[args.iter().position(|a| a == "-vf").unwrap() + 1];
        assert_eq!(
            scale,
            "scale=w=min(1920\\,iw):h=min(1080\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2"
        );
        assert_eq!(args.last().unwrap(), "/appdata/cache/media/1.part.mp4");
        assert!(
            !joined.contains("cuda") && !joined.contains("vaapi"),
            "on the CPU"
        );
    }

    #[test]
    fn audio_only_becomes_an_aac_mp4() {
        let args = strings(&encode_args(Path::new("a.wma"), Path::new("o.mp4"), false));
        let joined = args.join(" ");
        assert!(joined.contains("-map 0:a:0 -vn"), "{joined}");
        assert!(joined.contains("-c:a aac -b:a 192k"), "{joined}");
        assert!(!joined.contains("libx264"), "{joined}");
    }

    #[test]
    fn reads_progress_lines() {
        assert_eq!(progress_percent("out_time_us=500000", Some(2000)), Some(25));
        assert_eq!(
            progress_percent("out_time_us=9000000", Some(2000)),
            Some(99)
        );
        assert_eq!(progress_percent("out_time_us=N/A", Some(2000)), None);
        assert_eq!(progress_percent("out_time_us=5", None), None);
        assert_eq!(progress_percent("progress=end", None), Some(100));
        assert_eq!(progress_percent("frame=3", Some(2000)), None);
    }

    #[test]
    fn sweeps_only_unkept_numbered_files() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "1.mp4",
            "1.part.mp4",
            "2.mp4",
            "3.part.mp4",
            "notes.txt",
            "4.bin",
        ] {
            std::fs::write(dir.path().join(name), b"").unwrap();
        }
        sweep(dir.path(), |id| id == 1, ".mp4");
        let mut left: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["1.mp4", "1.part.mp4", "4.bin", "notes.txt"]);
    }
}
