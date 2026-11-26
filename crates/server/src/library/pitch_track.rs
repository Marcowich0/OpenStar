//! A Song's Pitch track: computed by a Pitch track job over the Song's
//! original audio file (the file `#MP3`/`#AUDIO` names, never a cache
//! conversion), cached in `/appdata/cache/pitch/<song id>.bin` and downloaded
//! by the browser, which fits on it. Nothing here runs during the Library
//! scan, and nothing here fits or changes a Song.
//!
//! **The job** runs in the Pitch track lane (one at a time; its children at
//! niceness 19, the detector thread lowered to the same). ffmpeg decodes the
//! audio to 16 kHz mono little-endian `f32` PCM on a pipe
//! ([`ToolCommand::run_bytes`](crate::jobs::ToolCommand::run_bytes)), then
//! YIN ([`Yin`]) runs on a thread of its own, off the async runtime. The
//! whole job has a hard timeout ([`TIMEOUT`]); a timeout or any failure ends
//! it with [`UserMessage::PitchTrackFailed`]. When the index has no loudness
//! for the audio file yet, the job measures it too ([`loudness::measure_once`]).
//!
//! **The cache file** is a header, then the frames:
//!
//! | bytes | value |
//! |---|---|
//! | 4 | `OSPT` |
//! | 4 | format version (`u32`, 1) |
//! | 4 | detector version (`u32`, [`TrackDetector::version`]) |
//! | 8 | the audio file's size in bytes (`u64`) |
//! | 8 | its modification time, ns since the Unix epoch (`i64`) |
//! | 4 | `n`, the length of its path (`u32`) |
//! | n | its path relative to the Library, UTF-8 |
//! | 12 × frames | per 10 ms frame: pitch (Hz, 0 unvoiced), clarity, RMS envelope (`f32` each) |
//!
//! All numbers are little-endian. The track is current while the header's
//! path, size, mtime and detector version match the Song's audio file and
//! this build's detector; otherwise it is computed again. The download is
//! the frames exactly as stored. The scan removes a Song's file when its
//! audio left the Library or changed (`conversion::sync`).

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use openstar_detector::{PitchTrack, TRACK_SAMPLE_RATE, TrackDetector, Yin};
use openstar_protocol::UserMessage;
use openstar_protocol::jobs::{JobId, JobState};
use openstar_protocol::library::SongId;
use openstar_protocol::pitch_track::PitchTrackStart;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, oneshot};

use super::conversion::PITCH_CACHE;
use super::{index, loudness, scan};
use crate::AppState;
use crate::jobs::{JobContext, JobEnv, JobParams, Progress, Slot};

/// A Pitch track job gives up after this long.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(120);

const MAGIC: &[u8; 4] = b"OSPT";
const FORMAT_VERSION: u32 = 1;
/// Bytes per stored frame: pitch, clarity, envelope.
const FRAME_BYTES: usize = 12;

/// Share of the job's progress the decoding takes; the detector takes the
/// rest up to [`DETECTED`].
const DECODED: f64 = 30.0;
const DETECTED: f64 = 97.0;

/// What a cached track was computed from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TrackKey {
    /// The audio file, relative to the Library.
    pub path: String,
    pub size: u64,
    pub mtime_ns: i64,
    pub detector_version: u32,
}

/// The cache file for `track`, computed from `key`.
pub(crate) fn encode(key: &TrackKey, track: &PitchTrack) -> Vec<u8> {
    let path = key.path.as_bytes();
    let mut bytes = Vec::with_capacity(32 + path.len() + track.pitch.len() * FRAME_BYTES);
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    bytes.extend_from_slice(&key.detector_version.to_le_bytes());
    bytes.extend_from_slice(&key.size.to_le_bytes());
    bytes.extend_from_slice(&key.mtime_ns.to_le_bytes());
    let length = u32::try_from(path.len()).unwrap_or(u32::MAX);
    bytes.extend_from_slice(&length.to_le_bytes());
    bytes.extend_from_slice(path);
    bytes.extend_from_slice(&frames(track));
    bytes
}

/// The frames of `track` as they are stored and downloaded.
pub(crate) fn frames(track: &PitchTrack) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(track.pitch.len() * FRAME_BYTES);
    for ((pitch, clarity), envelope) in track.pitch.iter().zip(&track.clarity).zip(&track.envelope)
    {
        bytes.extend_from_slice(&pitch.to_le_bytes());
        bytes.extend_from_slice(&clarity.to_le_bytes());
        bytes.extend_from_slice(&envelope.to_le_bytes());
    }
    bytes
}

/// Splits a cache file into its key and its frames; `None` when it is not a
/// cache file this build reads.
pub(crate) fn decode(bytes: &[u8]) -> Option<(TrackKey, &[u8])> {
    let rest = bytes.strip_prefix(MAGIC)?;
    let (format, rest) = take::<4>(rest)?;
    if u32::from_le_bytes(format) != FORMAT_VERSION {
        return None;
    }
    let (detector_version, rest) = take::<4>(rest)?;
    let (size, rest) = take::<8>(rest)?;
    let (mtime_ns, rest) = take::<8>(rest)?;
    let (length, rest) = take::<4>(rest)?;
    let length = usize::try_from(u32::from_le_bytes(length)).ok()?;
    let path = std::str::from_utf8(rest.get(..length)?).ok()?;
    let frames = &rest[length..];
    if !frames.len().is_multiple_of(FRAME_BYTES) {
        return None;
    }
    Some((
        TrackKey {
            path: path.to_owned(),
            size: u64::from_le_bytes(size),
            mtime_ns: i64::from_le_bytes(mtime_ns),
            detector_version: u32::from_le_bytes(detector_version),
        },
        frames,
    ))
}

fn take<const N: usize>(bytes: &[u8]) -> Option<([u8; N], &[u8])> {
    let (head, rest) = bytes.split_first_chunk::<N>()?;
    Some((*head, rest))
}

/// The ffmpeg arguments that decode the first audio stream of `source` to
/// 16 kHz mono little-endian `f32` PCM on stdout.
fn decode_args(source: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error"]
        .map(OsString::from)
        .to_vec();
    args.push("-i".into());
    args.push(source.as_os_str().to_owned());
    args.extend(["-map", "0:a:0", "-ac", "1", "-ar"].map(OsString::from));
    args.push(TRACK_SAMPLE_RATE.to_string().into());
    args.extend(["-f", "f32le", "-"].map(OsString::from));
    args
}

/// Collects little-endian `f32` samples from chunks split anywhere.
#[derive(Debug, Default)]
struct Samples {
    samples: Vec<f32>,
    partial: Vec<u8>,
}

impl Samples {
    fn push(&mut self, mut chunk: &[u8]) {
        if !self.partial.is_empty() {
            let wanted = (4 - self.partial.len()).min(chunk.len());
            self.partial.extend_from_slice(&chunk[..wanted]);
            chunk = &chunk[wanted..];
            if let Ok(sample) = <[u8; 4]>::try_from(self.partial.as_slice()) {
                self.samples.push(f32::from_le_bytes(sample));
                self.partial.clear();
            }
        }
        let (whole, rest) = chunk.as_chunks::<4>();
        self.samples
            .extend(whole.iter().map(|sample| f32::from_le_bytes(*sample)));
        self.partial.extend_from_slice(rest);
    }
}

/// A Pitch track job: computes the Song's track unless it is cached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchTrackJob {
    pub song: SongId,
    /// Its hard timeout; [`TIMEOUT`] except in tests.
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_timeout_ms() -> u64 {
    u64::try_from(TIMEOUT.as_millis()).unwrap_or(u64::MAX)
}

fn env_of(state: &AppState) -> JobEnv {
    JobEnv {
        db: state.db.clone(),
        live: state.live.clone(),
        songs_dir: state.config.songs_dir.clone(),
        appdata_dir: state.config.appdata_dir.clone(),
    }
}

/// The cache file of `song` below the appdata folder.
fn cache_file(appdata_dir: &Path, song: SongId) -> PathBuf {
    appdata_dir
        .join(PITCH_CACHE)
        .join(format!("{}.bin", song.0))
}

/// The key a current track of `song` has now: its audio file's path, size
/// and mtime, and this build's detector. `None` when `song` is not a
/// playable Song with audio, or its audio file cannot be read.
async fn current_key(env: &JobEnv, song: SongId) -> anyhow::Result<Option<TrackKey>> {
    let Some(path) = env
        .db
        .call(move |conn| index::media_path(conn, song, index::MediaRole::Audio))
        .await?
    else {
        return Ok(None);
    };
    let source = env.songs_dir.join(&path);
    let metadata = tokio::task::spawn_blocking(move || std::fs::metadata(source)).await?;
    Ok(metadata.ok().map(|metadata| TrackKey {
        path,
        size: metadata.len(),
        mtime_ns: scan::mtime_ns(&metadata),
        detector_version: Yin::VERSION,
    }))
}

/// The cached frames of `song` if its cache file matches `key`.
async fn cached_frames(env: &JobEnv, song: SongId, key: &TrackKey) -> Option<Vec<u8>> {
    let file = cache_file(&env.appdata_dir, song);
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(file))
        .await
        .ok()?
        .ok()?;
    let (stored, frames) = decode(&bytes)?;
    (stored == *key).then(|| frames.to_vec())
}

/// The Pitch track job computing each Song's track, by its cache file
/// (absolute, so apps in one test process never meet). A request while it
/// is queued or running joins it.
static COMPUTING: LazyLock<Mutex<HashMap<PathBuf, JobId>>> = LazyLock::new(Mutex::default);

/// Answers whether `song`'s track is ready or which job computes it,
/// starting one when none does. `None` when `song` has no audio to listen to.
pub(crate) async fn start(
    state: &AppState,
    song: SongId,
    timeout: Duration,
) -> anyhow::Result<Option<PitchTrackStart>> {
    let env = env_of(state);
    let Some(key) = current_key(&env, song).await? else {
        return Ok(None);
    };
    if cached_frames(&env, song, &key).await.is_some() {
        return Ok(Some(PitchTrackStart::Ready));
    }
    let file = cache_file(&env.appdata_dir, song);
    let mut computing = COMPUTING.lock().await;
    if let Some(job) = computing.get(&file).copied() {
        let unfinished =
            state.jobs.list().await.unwrap_or_default().iter().any(|j| {
                j.id == job && matches!(j.state, JobState::Queued | JobState::Running { .. })
            });
        if unfinished {
            return Ok(Some(PitchTrackStart::Computing { job }));
        }
    }
    let job = state
        .jobs
        .enqueue(JobParams::PitchTrack(PitchTrackJob {
            song,
            timeout_ms: u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX),
        }))
        .await?;
    computing.insert(file, job);
    Ok(Some(PitchTrackStart::Computing { job }))
}

impl PitchTrackJob {
    pub(crate) async fn run(self, ctx: &mut JobContext) -> Result<(), UserMessage> {
        let song = self.song;
        let timeout = Duration::from_millis(self.timeout_ms);
        match tokio::time::timeout(timeout, compute(ctx, song)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(UserMessage::JobCancelled)) => Err(UserMessage::JobCancelled),
            Ok(Err(reason)) => {
                tracing::warn!(song = song.0, ?reason, "a Pitch track job failed");
                Err(UserMessage::PitchTrackFailed)
            }
            // Dropping the work kills its ffmpeg; a detector thread still
            // running ends on its own and its track is dropped.
            Err(_) => {
                tracing::warn!(song = song.0, ?timeout, "a Pitch track job timed out");
                Err(UserMessage::PitchTrackFailed)
            }
        }
    }
}

async fn compute(ctx: &JobContext, song: SongId) -> Result<(), UserMessage> {
    let env = &ctx.env;
    let Some(key) = current_key(env, song).await.map_err(server_error)? else {
        tracing::warn!(song = song.0, "the Song has no audio to listen to");
        return Err(UserMessage::PitchTrackFailed);
    };
    if cached_frames(env, song, &key).await.is_some() {
        // An earlier job wrote it meanwhile.
        ctx.progress.report(100);
        return Ok(());
    }
    ctx.progress.report(0);

    let wanted = key.path.clone();
    let duration: Option<f64> = env
        .db
        .call(move |conn| {
            conn.query_row(
                "SELECT duration_seconds FROM media_probes WHERE path = ?1",
                [wanted],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
        })
        .await
        .map_err(server_error)?;
    let samples = decode_audio(
        &ctx.slot,
        &ctx.progress,
        &env.songs_dir.join(&key.path),
        duration,
    )
    .await?;
    let track = detect(&ctx.slot, ctx.progress.detached(), samples).await?;

    let file = cache_file(&env.appdata_dir, song);
    let bytes = encode(&key, &track);
    tokio::task::spawn_blocking(move || write_atomically(&file, &bytes))
        .await
        .map_err(|error| server_error(error.into()))?
        .map_err(|error| server_error(error.into()))?;

    match loudness::measure_once(&ctx.slot, env, &key.path).await {
        Ok(()) => {}
        Err(UserMessage::JobCancelled) => return Err(UserMessage::JobCancelled),
        // The track is fine; the scan's loudness pass measures it later.
        Err(reason) => {
            tracing::warn!(
                path = key.path,
                ?reason,
                "measuring loudness for a Pitch track"
            );
        }
    }
    ctx.progress.report(100);
    Ok(())
}

/// Decodes `source` to the detector's samples.
async fn decode_audio(
    slot: &Slot,
    progress: &Progress,
    source: &Path,
    duration_seconds: Option<f64>,
) -> Result<Vec<f32>, UserMessage> {
    let mut command = slot.command("ffmpeg");
    for arg in decode_args(source) {
        command = command.arg(arg);
    }
    let mut samples = Samples::default();
    let expected = duration_seconds
        .filter(|d| d.is_finite() && *d > 0.0)
        .map(|d| d * f64::from(TRACK_SAMPLE_RATE));
    command
        .run_bytes(|chunk| {
            samples.push(chunk);
            if let Some(expected) = expected {
                #[expect(clippy::cast_precision_loss, reason = "a share for progress")]
                let share = (samples.samples.len() as f64 / expected).min(1.0);
                progress.report(percent(share * DECODED));
            }
        })
        .await?;
    Ok(samples.samples)
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "clamped to 0..=100 first"
)]
fn percent(value: f64) -> u8 {
    value.clamp(0.0, 100.0) as u8
}

/// Runs YIN over `samples` on a thread of its own, lowered to the lane's
/// low priority, so neither the async runtime nor the relay waits on it.
async fn detect(
    slot: &Slot,
    progress: Progress,
    samples: Vec<f32>,
) -> Result<PitchTrack, UserMessage> {
    let (thread_id, thread_known) = oneshot::channel();
    let (go, gone) = std::sync::mpsc::channel::<()>();
    let (done, track) = oneshot::channel();
    std::thread::Builder::new()
        .name("pitch-track".to_owned())
        .spawn(move || {
            let _ = thread_id.send(own_thread_id());
            // Waits until its priority is lowered (or that was given up).
            let _ = gone.recv();
            let mut detector = Yin::new();
            let track = detector.track(&samples, &mut |share| {
                progress.report(percent(DECODED + share * (DETECTED - DECODED)));
            });
            let _ = done.send(track);
        })
        .map_err(|error| server_error(error.into()))?;
    if let Ok(Some(id)) = thread_known.await {
        lower_priority(slot, &id).await?;
    }
    drop(go);

    let cancelled = slot.cancelled();
    tokio::select! {
        () = cancelled => Err(UserMessage::JobCancelled),
        track = track => track.map_err(|_| UserMessage::ServerError),
    }
}

/// The calling thread's id (Linux), for `renice`.
fn own_thread_id() -> Option<String> {
    let link = std::fs::read_link("/proc/thread-self").ok()?;
    Some(link.file_name()?.to_string_lossy().into_owned())
}

/// Lowers thread `id` to niceness 19 with `renice`, best effort: without it
/// the detector runs at normal priority.
async fn lower_priority(slot: &Slot, id: &str) -> Result<(), UserMessage> {
    let result = slot
        .command("renice")
        .arg("-n")
        .arg("19")
        .arg("-p")
        .arg(id)
        .run_lines(|_| {})
        .await;
    match result {
        Err(UserMessage::JobCancelled) => Err(UserMessage::JobCancelled),
        Err(reason) => {
            tracing::debug!(?reason, "lowering the Pitch track detector's priority");
            Ok(())
        }
        Ok(()) => Ok(()),
    }
}

/// Writes `bytes` to `file` through a temporary file beside it, so a reader
/// never sees half a track.
fn write_atomically(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut part = file.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    std::fs::write(&part, bytes)?;
    std::fs::rename(&part, file)
}

fn server_error(error: anyhow::Error) -> UserMessage {
    tracing::error!(?error, "a Pitch track job");
    UserMessage::ServerError
}

/// `POST /api/songs/{id}/pitch-track`: [`PitchTrackStart`]; `404` when the
/// id is not a playable Song with an audio file.
pub(crate) async fn request(State(state): State<AppState>, UrlPath(id): UrlPath<u32>) -> Response {
    answer(&state, SongId(id), TIMEOUT).await
}

/// `POST /api/songs/{id}/auto-fit`: a Phone starts Fit to the singing
/// (#223). The same answer as the Pitch track request, but guarded: on a
/// Phone, running the fit needs an Unlock (docs/agents/guard-rule.md).
/// Refused with `409 songPlaying` for the Song playing on the Stage now
/// (#225).
pub(crate) async fn auto_fit(State(state): State<AppState>, UrlPath(id): UrlPath<u32>) -> Response {
    if state.live.song_playing(SongId(id)).await {
        return (StatusCode::CONFLICT, axum::Json(UserMessage::SongPlaying)).into_response();
    }
    answer(&state, SongId(id), TIMEOUT).await
}

/// Query of the test-only `POST /api/test/songs/{id}/pitch-track`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestTimeout {
    timeout_ms: u64,
}

/// `POST /api/test/songs/{id}/pitch-track?timeoutMs=`: the same request with
/// a short timeout, so tests reach the timeout path.
pub(crate) async fn request_test(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<u32>,
    Query(query): Query<TestTimeout>,
) -> Response {
    answer(&state, SongId(id), Duration::from_millis(query.timeout_ms)).await
}

async fn answer(state: &AppState, song: SongId, timeout: Duration) -> Response {
    match start(state, song, timeout).await {
        Ok(Some(start)) => axum::Json(start).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(?error, "starting a Pitch track");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// `GET /api/songs/{id}/pitch-track`: the current cached track's frames as
/// stored; `404` when there is none (ask for it with `POST` first).
pub(crate) async fn download(State(state): State<AppState>, UrlPath(id): UrlPath<u32>) -> Response {
    let env = env_of(&state);
    let song = SongId(id);
    let key = match current_key(&env, song).await {
        Ok(Some(key)) => key,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(?error, "downloading a Pitch track");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    match cached_frames(&env, song, &key).await {
        Some(frames) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            frames,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> TrackKey {
        TrackKey {
            path: "A - B/b.ogg".to_owned(),
            size: 0x0102,
            mtime_ns: -3,
            detector_version: 7,
        }
    }

    fn track(frames: &[[f32; 3]]) -> PitchTrack {
        PitchTrack {
            frame_seconds: 0.01,
            pitch: frames.iter().map(|f| f[0]).collect(),
            clarity: frames.iter().map(|f| f[1]).collect(),
            envelope: frames.iter().map(|f| f[2]).collect(),
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The shared fixture both the Rust writer and the TypeScript reader
    /// are held to.
    #[test]
    fn frames_are_written_as_the_shared_fixture_pins() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/pitch-track/frames.json"
        ))
        .unwrap();
        let fixture: serde_json::Value = serde_json::from_str(&text).unwrap();
        #[expect(clippy::cast_possible_truncation, reason = "the fixture's f32 values")]
        let frames: Vec<[f32; 3]> = fixture["frames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                let f: Vec<f32> = f
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_f64().unwrap() as f32)
                    .collect();
                [f[0], f[1], f[2]]
            })
            .collect();
        assert_eq!(hex(&super::frames(&track(&frames))), fixture["bytes"]);
    }

    #[test]
    fn the_cache_file_is_the_header_then_the_frames() {
        let bytes = encode(&key(), &track(&[[220.0, 0.5, 0.25]]));
        assert_eq!(
            hex(&bytes),
            concat!(
                "4f535054",               // OSPT
                "01000000",               // format 1
                "07000000",               // detector version 7
                "0201000000000000",       // size 0x0102
                "fdffffffffffffff",       // mtime -3 ns
                "0b000000",               // path: 11 bytes
                "41202d20422f622e6f6767", // "A - B/b.ogg"
                "00005c43",               // 220.0
                "0000003f",               // 0.5
                "0000803e",               // 0.25
            )
        );
        let (stored, frames) = decode(&bytes).unwrap();
        assert_eq!(stored, key());
        assert_eq!(hex(frames), "00005c430000003f0000803e");
    }

    #[test]
    fn a_file_this_build_does_not_read_is_no_track() {
        let bytes = encode(&key(), &track(&[[220.0, 0.5, 0.25]]));
        assert!(decode(&bytes[..bytes.len() - 1]).is_none(), "half a frame");
        assert!(decode(&bytes[..20]).is_none(), "cut in the header");
        assert!(decode(b"").is_none());
        let mut other_format = bytes.clone();
        other_format[4] = 2;
        assert!(decode(&other_format).is_none());
        let mut not_ours = bytes;
        not_ours[0] = b'X';
        assert!(decode(&not_ours).is_none());
    }

    #[test]
    fn decodes_the_first_audio_stream_to_16_khz_mono_f32() {
        let args: Vec<String> = decode_args(Path::new("/songs/A/a.ogg"))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let joined = args.join(" ");
        assert!(
            joined.contains("-i /songs/A/a.ogg -map 0:a:0 -ac 1 -ar 16000 -f f32le -"),
            "{joined}"
        );
    }

    #[test]
    fn samples_split_across_chunks_are_put_together() {
        let bytes: Vec<u8> = [1.5_f32, -0.25, 3.0]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let mut samples = Samples::default();
        samples.push(&bytes[..3]);
        samples.push(&bytes[3..4]);
        samples.push(&bytes[4..9]);
        samples.push(&bytes[9..]);
        assert_eq!(samples.samples, [1.5, -0.25, 3.0]);
    }

    #[test]
    fn an_old_job_row_gets_the_spec_timeout() {
        let job: PitchTrackJob = serde_json::from_str(r#"{"song":4}"#).unwrap();
        assert_eq!(job.timeout_ms, 120_000);
    }
}
