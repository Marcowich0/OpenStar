//! Each Song's loudness: EBU R128 integrated loudness in LUFS, measured
//! with ffmpeg's `ebur128` filter over the Song's original audio file (never
//! a cache conversion) and kept in the index (`media_loudness`, keyed by the
//! audio file's path, size and mtime as probed). Nothing is written to the
//! Library. The Song gain built from it belongs to the playback area.
//!
//! After probing, the scan's [`sync`] drops the measurements of files that
//! left or changed and queues one [`Measurement`] job in the ffmpeg lane
//! (shared with conversions, cap 2) per audio file still unmeasured. A job
//! picks its file only when it starts: the unmeasured audio of a Song in the
//! Queue first, then the rest by path. So a Song queued while others wait is
//! measured next, and no job is tied to a file that has left meanwhile.
//!
//! A Song not measured yet plays (at unity gain); it is never "preparing"
//! for its loudness. The Pitch track job (#57) calls [`measure_once`] for
//! the Song it decodes, which measures only when the index has nothing for
//! the audio file's current size and mtime.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};

use openstar_protocol::jobs::{JobKind, JobState};
use openstar_protocol::{ChangeTopic, UserMessage};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::jobs::{JobContext, JobEnv, JobParams, Jobs, Progress, Slot};

/// A measurement job. It names no file: it measures the most urgent
/// unmeasured audio file when it starts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {}

/// An audio file as the index knows it.
#[derive(Debug, Clone, PartialEq)]
struct Audio {
    /// Relative to the Library.
    path: String,
    size: i64,
    mtime_ns: i64,
    duration_seconds: Option<f64>,
}

/// The audio files being measured right now, as absolute paths (so apps in
/// one test process never meet), so two jobs never measure one file.
static MEASURING: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Mutex::default);

/// Holds one file in [`MEASURING`] while it lives.
struct Claim(PathBuf);

impl Claim {
    fn take(path: PathBuf) -> Option<Self> {
        let mut measuring = MEASURING.lock().unwrap_or_else(PoisonError::into_inner);
        // Not `then_some`: a refused claim dropped here would lock again.
        measuring.insert(path.clone()).then(|| Self(path))
    }

    fn held(path: &Path) -> bool {
        MEASURING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(path)
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        MEASURING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.0);
    }
}

/// The ffmpeg arguments that measure `source`: its first audio stream
/// through `ebur128` with per-frame metadata, printed to stdout as
/// `frame:… pts_time:<s>` and `lavfi.r128.I=<LUFS>` lines, every 100 ms.
fn measure_args(source: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error"]
        .map(OsString::from)
        .to_vec();
    args.push("-i".into());
    args.push(source.as_os_str().to_owned());
    args.extend(
        [
            "-map",
            "0:a:0",
            "-af",
            "ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.I:file=-",
            "-f",
            "null",
            "-",
        ]
        .map(OsString::from),
    );
    args
}

/// Reads ffmpeg's lines: the integrated loudness so far, and how far it is.
#[derive(Debug, Default)]
struct Reading {
    lufs: Option<f64>,
}

impl Reading {
    /// Takes one line; returns the seconds read so far when it says them.
    fn line(&mut self, line: &str) -> Option<f64> {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("lavfi.r128.I=") {
            self.lufs = value.trim().parse::<f64>().ok().filter(|v| v.is_finite());
            return None;
        }
        let (_, time) = line.split_once("pts_time:")?;
        time.split_whitespace().next()?.parse().ok()
    }
}

/// Measures `source`; `None` when ffmpeg gave no loudness (no audio frames).
async fn measure(
    slot: &Slot,
    progress: Option<&Progress>,
    source: &Path,
    duration_seconds: Option<f64>,
) -> Result<Option<f64>, UserMessage> {
    let mut command = slot.command("ffmpeg");
    for arg in measure_args(source) {
        command = command.arg(arg);
    }
    let mut reading = Reading::default();
    command
        .run_lines(|line| {
            if let (Some(seconds), Some(progress), Some(total)) = (
                reading.line(line),
                progress,
                duration_seconds.filter(|d| *d > 0.0),
            ) {
                #[expect(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "clamped to 0..=99 first"
                )]
                progress.report((seconds / total * 100.0).clamp(0.0, 99.0) as u8);
            }
        })
        .await?;
    Ok(reading.lufs)
}

impl Measurement {
    pub(crate) fn params(self) -> JobParams {
        JobParams::Loudness(self)
    }

    pub(crate) async fn run(self, ctx: &mut JobContext) -> Result<(), UserMessage> {
        let env = ctx.env.clone();
        let songs_dir = env.songs_dir.clone();
        let Some((audio, _claim)) = env
            .db
            .call(move |conn| next(conn, &songs_dir))
            .await
            .map_err(server_error)?
        else {
            // Every file is measured (or being measured) already.
            return Ok(());
        };
        let source = env.songs_dir.join(&audio.path);
        let result = measure(
            &ctx.slot,
            Some(&ctx.progress),
            &source,
            audio.duration_seconds,
        )
        .await;
        let lufs = match result {
            Ok(lufs) => lufs,
            // Left unmeasured: measured again by the next start's jobs.
            Err(reason @ (UserMessage::JobCancelled | UserMessage::ToolNotFound { .. })) => {
                return Err(reason);
            }
            Err(reason) => {
                tracing::warn!(path = audio.path, ?reason, "a loudness measurement failed");
                // Kept as measured without a value, so it is not tried again
                // until the file changes; the Song plays at unity gain.
                record(&env.db, audio, None).await?;
                env.live.changed(vec![ChangeTopic::Library]).await;
                return Err(reason);
            }
        };
        if lufs.is_none() {
            tracing::warn!(path = audio.path, "ffmpeg measured no loudness");
        }
        record(&env.db, audio, lufs).await?;
        env.live.changed(vec![ChangeTopic::Library]).await;
        Ok(())
    }
}

/// Measures the loudness of the Library audio file `path` (relative to the
/// Library) and records it, unless the index already has one for the file's
/// current size and mtime. For the Pitch track job, which runs it in its own
/// slot; it never replaces the scan's pass. Does nothing for a file the
/// index has not probed.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the seam the Pitch track job (#57) calls")
)]
pub(crate) async fn measure_once(slot: &Slot, env: &JobEnv, path: &str) -> Result<(), UserMessage> {
    let wanted = path.to_owned();
    let Some(audio) = env
        .db
        .call(move |conn| unmeasured(conn, &wanted))
        .await
        .map_err(server_error)?
    else {
        return Ok(());
    };
    let source = env.songs_dir.join(&audio.path);
    let Some(_claim) = Claim::take(source.clone()) else {
        // A measurement job has it.
        return Ok(());
    };
    let lufs = measure(slot, None, &source, audio.duration_seconds).await?;
    record(&env.db, audio, lufs).await?;
    env.live.changed(vec![ChangeTopic::Library]).await;
    Ok(())
}

/// Stores `lufs` for `audio` unless the index already has a measurement for
/// it, or the file was probed again (changed) meanwhile.
async fn record(db: &Database, audio: Audio, lufs: Option<f64>) -> Result<(), UserMessage> {
    db.call(move |conn| {
        conn.execute(
            "INSERT INTO media_loudness (path, size, mtime_ns, lufs)
             SELECT p.path, p.size, p.mtime_ns, ?4 FROM media_probes p
             WHERE p.path = ?1 AND p.size = ?2 AND p.mtime_ns = ?3
             ON CONFLICT (path) DO UPDATE SET
                 size = excluded.size, mtime_ns = excluded.mtime_ns, lufs = excluded.lufs
             WHERE media_loudness.size != excluded.size
                 OR media_loudness.mtime_ns != excluded.mtime_ns",
            params![audio.path, audio.size, audio.mtime_ns, lufs],
        )
    })
    .await
    .map_err(server_error)?;
    Ok(())
}

fn server_error(error: anyhow::Error) -> UserMessage {
    tracing::error!(?error, "a loudness measurement");
    UserMessage::ServerError
}

/// The audio files to measure: the readable, probed audio of every playable
/// Song with no measurement for its current size and mtime. Songs in the
/// Queue come first (by their place in it), then the rest by path.
const UNMEASURED: &str = "
    SELECT p.path, p.size, p.mtime_ns, p.duration_seconds,
        (SELECT MIN(q.position) FROM queue_requests q
         JOIN library_files g ON g.id = q.song_id
         WHERE g.audio_path = p.path) AS queued
    FROM media_probes p
    WHERE p.container IS NOT NULL
        AND EXISTS (SELECT 1 FROM library_files f WHERE f.audio_path = p.path AND f.playable)
        AND NOT EXISTS (SELECT 1 FROM media_loudness l
            WHERE l.path = p.path AND l.size = p.size AND l.mtime_ns = p.mtime_ns)";

fn audio_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Audio> {
    Ok(Audio {
        path: row.get(0)?,
        size: row.get(1)?,
        mtime_ns: row.get(2)?,
        duration_seconds: row.get(3)?,
    })
}

/// The most urgent unmeasured file no one is measuring, claimed.
fn next(conn: &Connection, songs_dir: &Path) -> rusqlite::Result<Option<(Audio, Claim)>> {
    let mut statement = conn.prepare(&format!(
        "{UNMEASURED} ORDER BY queued IS NULL, queued, p.path"
    ))?;
    let rows = statement.query_map([], audio_row)?;
    for audio in rows {
        let audio = audio?;
        if let Some(claim) = Claim::take(songs_dir.join(&audio.path)) {
            return Ok(Some((audio, claim)));
        }
    }
    Ok(None)
}

/// `path`, if it is a probed audio file without a current measurement.
fn unmeasured(conn: &Connection, path: &str) -> rusqlite::Result<Option<Audio>> {
    conn.query_row(&format!("{UNMEASURED} AND p.path = ?1"), [path], audio_row)
        .optional()
}

/// After probing: drops the measurements of files that are no Song's audio
/// any more or changed, and queues a measurement job for every unmeasured
/// audio file beyond the measurement jobs already queued or running.
pub(crate) async fn sync(db: &Database, jobs: &Jobs, songs_dir: &Path) -> anyhow::Result<()> {
    let songs_dir = songs_dir.to_owned();
    let unmeasured = db
        .call(move |conn| {
            conn.execute(
                "DELETE FROM media_loudness AS l WHERE NOT EXISTS (
                     SELECT 1 FROM media_probes p JOIN library_files f ON f.audio_path = p.path
                     WHERE p.path = l.path AND p.size = l.size AND p.mtime_ns = l.mtime_ns)",
                [],
            )?;
            let mut statement = conn.prepare(UNMEASURED)?;
            let rows = statement.query_map([], audio_row)?;
            let mut count = 0usize;
            for audio in rows {
                // One being measured has its job running already.
                if !Claim::held(&songs_dir.join(audio?.path)) {
                    count += 1;
                }
            }
            Ok(count)
        })
        .await?;
    let waiting = jobs
        .list()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|job| job.kind == JobKind::Loudness && job.state == JobState::Queued)
        .count();
    for _ in waiting..unmeasured {
        jobs.enqueue(Measurement::default().params()).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_the_first_audio_stream_with_ebur128() {
        let args: Vec<String> = measure_args(Path::new("/songs/A/a.ogg"))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let joined = args.join(" ");
        assert!(joined.contains("-i /songs/A/a.ogg -map 0:a:0"), "{joined}");
        assert!(
            joined.contains("-af ebur128=metadata=1,ametadata="),
            "{joined}"
        );
        assert!(joined.ends_with("-f null -"), "writes no file: {joined}");
    }

    #[test]
    fn the_last_integrated_reading_is_the_songs_loudness() {
        let mut reading = Reading::default();
        assert_eq!(reading.line("frame:0    pts:0       pts_time:0"), Some(0.0));
        assert_eq!(reading.line("lavfi.r128.I=-70.000"), None);
        assert_eq!(reading.lufs, Some(-70.0));
        assert_eq!(
            reading.line("frame:19   pts:91200   pts_time:1.9"),
            Some(1.9)
        );
        reading.line("lavfi.r128.I=-21.070");
        assert_eq!(reading.lufs, Some(-21.07));
        reading.line("lavfi.r128.I=-inf");
        assert_eq!(reading.lufs, None, "not a loudness");
        assert_eq!(Reading::default().lufs, None);
    }

    /// An index with one playable Song whose audio `tone.wav` (a 1 kHz tone
    /// at 1/8 of full scale) is probed at size 1, mtime 1.
    async fn index_with_a_tone(songs: &Path, appdata: &Path) -> JobEnv {
        let media = openstar_test_harness::Media::new();
        let tone = media.tone("tone.wav", 1000.0, 1.0, 48_000).unwrap();
        std::fs::copy(tone, songs.join("tone.wav")).unwrap();
        let db = Database::open(appdata).await.unwrap().database;
        db.call(|conn| {
            conn.execute_batch(
                "INSERT INTO library_files (path, size, mtime_ns, parser_version, duet,
                     txt_problems, file_references, playable, audio_path)
                 VALUES ('song.txt', 1, 1, 1, 0, '[]', '[]', 1, 'tone.wav');
                 INSERT INTO media_probes (path, size, mtime_ns, container, audio_codec, native)
                 VALUES ('tone.wav', 1, 1, 'wav', 'pcm_s16le', 0);",
            )
        })
        .await
        .unwrap();
        let live = crate::live::LiveHandle::start(db.clone()).await.unwrap();
        JobEnv {
            db,
            live,
            songs_dir: songs.to_owned(),
            appdata_dir: appdata.to_owned(),
        }
    }

    async fn stored(env: &JobEnv) -> Vec<(i64, i64, Option<f64>)> {
        env.db
            .call(|conn| {
                let mut statement =
                    conn.prepare("SELECT size, mtime_ns, lufs FROM media_loudness")?;
                let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
                rows.collect()
            })
            .await
            .unwrap()
    }

    fn slot(path: Option<String>) -> Slot {
        Slot::outside_lanes(path, tokio::sync::watch::channel(false).1)
    }

    #[tokio::test]
    async fn the_pitch_track_job_measures_only_what_the_index_lacks() {
        let songs = tempfile::tempdir().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let env = index_with_a_tone(songs.path(), appdata.path()).await;

        measure_once(&slot(None), &env, "tone.wav").await.unwrap();
        let measured = stored(&env).await;
        assert_eq!(measured.len(), 1);
        let (size, mtime, lufs) = measured[0];
        assert_eq!((size, mtime), (1, 1), "keyed by the probed size and mtime");
        assert!((lufs.unwrap() - -21.07).abs() < 0.2, "{lufs:?}");

        // Known for this size and mtime: not measured again (an empty PATH
        // would fail any ffmpeg), and the scan's value stays.
        env.db
            .call(|c| c.execute("UPDATE media_loudness SET lufs = -9.5", []))
            .await
            .unwrap();
        measure_once(&slot(Some(String::new())), &env, "tone.wav")
            .await
            .unwrap();
        assert_eq!(stored(&env).await, [(1, 1, Some(-9.5))]);

        // Not a probed file: nothing to do.
        measure_once(&slot(Some(String::new())), &env, "other.wav")
            .await
            .unwrap();

        // Probed again at a new mtime: measured again.
        env.db
            .call(|c| c.execute("UPDATE media_probes SET mtime_ns = 2", []))
            .await
            .unwrap();
        measure_once(&slot(None), &env, "tone.wav").await.unwrap();
        let measured = stored(&env).await;
        assert_eq!(measured.len(), 1);
        assert_eq!((measured[0].0, measured[0].1), (1, 2));
        assert!((measured[0].2.unwrap() - -21.07).abs() < 0.2);
    }
}
