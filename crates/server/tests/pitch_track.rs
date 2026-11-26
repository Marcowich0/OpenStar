//! A Song's Pitch track through the real app over HTTP and WebSocket: the
//! Pitch track job with the real ffmpeg on the fixture Library's sine-melody
//! Song (its audio generated at test time from its Notes), its cache in
//! `/appdata/cache/pitch/` and the track download.
//!
//! A stand-in `ffmpeg` first on the app's `PATH` runs the real one, except
//! that a loudness measurement waits until `open-loudness` exists beside it,
//! a PCM decode hangs while `hang` exists and fails while `fail` exists.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use openstar_detector::Yin;
use openstar_protocol::jobs::{JobId, JobKind, JobList, JobState};
use openstar_protocol::library::{SongDetail, SongId, SongList};
use openstar_protocol::pitch_track::PitchTrackStart;
use openstar_protocol::{ServerMessage, UserMessage};
use openstar_test_harness::fixture_library::{SINE_MELODY, read_song};
use openstar_test_harness::{AppFolders, TestApp, WsClient};

/// The real program `name` on the test process's `PATH`.
fn real(name: &str) -> PathBuf {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
        .unwrap_or_else(|| panic!("{name} is not installed"))
}

fn stand_in_ffmpeg() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let script = format!(
        "#!/bin/sh\n\
         case \"$*\" in *ebur128*)\n\
           while [ ! -e '{open}' ]; do sleep 0.02; done ;;\n\
         esac\n\
         case \"$*\" in *f32le*)\n\
           if [ -e '{hang}' ]; then exec sleep 30; fi\n\
           if [ -e '{fail}' ]; then exit 3; fi ;;\n\
         esac\n\
         exec '{ffmpeg}' \"$@\"\n",
        open = dir.path().join("open-loudness").display(),
        hang = dir.path().join("hang").display(),
        fail = dir.path().join("fail").display(),
        ffmpeg = real("ffmpeg").display(),
    );
    openstar_test_harness::write_executable(&dir.path().join("ffmpeg"), &script).unwrap();
    dir
}

fn mark(tools: &tempfile::TempDir, name: &str) {
    std::fs::write(tools.path().join(name), b"").unwrap();
}

async fn start(tools: &tempfile::TempDir) -> TestApp {
    TestApp::builder()
        .folders(AppFolders::with_fixture_library())
        .tools_first(tools.path())
        .test_routes()
        .start()
        .await
}

async fn sine_melody(app: &TestApp) -> SongId {
    app.get_json::<SongList>("/api/songs")
        .await
        .songs
        .into_iter()
        .find(|s| s.path == SINE_MELODY)
        .expect("the sine-melody Song is listed")
        .id
}

async fn request(app: &TestApp, path: &str) -> PitchTrackStart {
    let response = app.http().post(app.url(path)).send().await.unwrap();
    assert_eq!(response.status(), 200, "POST {path}");
    response.json().await.unwrap()
}

async fn ask(app: &TestApp, song: SongId) -> PitchTrackStart {
    request(app, &format!("/api/songs/{}/pitch-track", song.0)).await
}

fn computing(start: PitchTrackStart) -> JobId {
    match start {
        PitchTrackStart::Computing { job } => job,
        PitchTrackStart::Ready => panic!("expected a job, the track was ready"),
    }
}

/// Waits on the WebSocket for job `id` to end; returns how it ended and
/// the percentages it reported on the way.
async fn ended(ws: &mut WsClient, id: JobId) -> (JobState, Vec<u8>) {
    let mut percents = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        assert!(tokio::time::Instant::now() < deadline, "job {id:?} ends");
        let ServerMessage::JobChanged { job } = ws.recv().await else {
            continue;
        };
        if job.id != id {
            continue;
        }
        assert_eq!(job.kind, JobKind::PitchTrack);
        match job.state {
            JobState::Running {
                percent: Some(percent),
            } => percents.push(percent),
            JobState::Queued | JobState::Running { percent: None } => {}
            state => return (state, percents),
        }
    }
}

async fn pitch_track_jobs(app: &TestApp) -> Vec<JobId> {
    app.get_json::<JobList>("/api/jobs")
        .await
        .jobs
        .into_iter()
        .filter(|job| job.kind == JobKind::PitchTrack)
        .map(|job| job.id)
        .collect()
}

/// The downloaded track: `(pitch, clarity, envelope)` per 10 ms frame.
async fn download(app: &TestApp, song: SongId) -> Vec<[f32; 3]> {
    let response = app
        .http()
        .get(app.url(&format!("/api/songs/{}/pitch-track", song.0)))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers()["content-type"],
        "application/octet-stream"
    );
    let bytes = response.bytes().await.unwrap();
    assert_eq!(bytes.len() % 12, 0, "whole frames");
    bytes
        .as_chunks::<12>()
        .0
        .iter()
        .map(|frame| {
            let value = |at: usize| f32::from_le_bytes(frame[at..at + 4].try_into().unwrap());
            [value(0), value(4), value(8)]
        })
        .collect()
}

fn cache_file(app: &TestApp, song: SongId) -> PathBuf {
    app.appdata_dir()
        .join("cache/pitch")
        .join(format!("{}.bin", song.0))
}

fn audio(app: &TestApp) -> PathBuf {
    app.songs_dir()
        .join(Path::new(SINE_MELODY).with_file_name("sine-melody.ogg"))
}

#[tokio::test]
async fn the_track_is_voiced_on_the_notes_cached_and_recomputed_when_its_key_changes() {
    let tools = stand_in_ffmpeg();
    mark(&tools, "open-loudness");
    let app = start(&tools).await;
    let song = sine_melody(&app).await;
    let mut ws = app.connect_ws().await;

    let missing = app
        .http()
        .get(app.url(&format!("/api/songs/{}/pitch-track", song.0)))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404, "nothing cached yet");

    // A second request while the job runs joins it.
    let job = computing(ask(&app, song).await);
    assert_eq!(computing(ask(&app, song).await), job);
    let (state, percents) = ended(&mut ws, job).await;
    assert_eq!(state, JobState::Done);
    assert!(!percents.is_empty(), "progress reached the browser");
    assert!(percents.is_sorted(), "{percents:?}");
    assert_eq!(pitch_track_jobs(&app).await, [job]);

    // Voiced on every Note at its pitch, unvoiced in the rest between Lines.
    let frames = download(&app, song).await;
    let parsed = read_song(&app.songs_dir().join(SINE_MELODY))
        .unwrap()
        .unwrap();
    let notes: Vec<_> = parsed
        .voices
        .iter()
        .flat_map(|v| v.lines.iter().flat_map(|l| l.notes.iter()))
        .collect();
    assert!(notes.len() > 10);
    for note in notes {
        let middle = parsed
            .headers
            .seconds_at_beat(f64::from(note.start) + f64::from(note.length) / 2.0);
        let hz = 440.0 * 2f64.powf(f64::from(note.pitch + 60 - 69) / 12.0);
        #[expect(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let frame = (middle / 0.01) as usize;
        for [pitch, clarity, envelope] in &frames[frame - 2..=frame + 2] {
            let pitch = f64::from(*pitch);
            assert!(
                (pitch / hz - 1.0).abs() < 0.03,
                "Note at beat {} ({hz:.1} Hz) heard as {pitch:.1} Hz",
                note.start
            );
            assert!(*clarity > 0.5 && *envelope > 0.01);
        }
    }
    let rest = parsed.headers.seconds_at_beat(57.0);
    #[expect(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let rest = (rest / 0.01) as usize;
    assert_eq!(frames[rest][0], 0.0, "unvoiced between Lines");

    // Current: served at once, no job.
    assert_eq!(ask(&app, song).await, PitchTrackStart::Ready);
    assert_eq!(pitch_track_jobs(&app).await, [job]);

    // A new mtime on the audio file: computed again.
    let file = std::fs::File::options()
        .write(true)
        .open(audio(&app))
        .unwrap();
    file.set_modified(SystemTime::now() + Duration::from_secs(30))
        .unwrap();
    let again = computing(ask(&app, song).await);
    assert_ne!(again, job);
    assert_eq!(ended(&mut ws, again).await.0, JobState::Done);
    assert_eq!(ask(&app, song).await, PitchTrackStart::Ready);

    // A cache written by another detector version: computed again.
    let cache = cache_file(&app, song);
    let mut bytes = std::fs::read(&cache).unwrap();
    assert_eq!(bytes[8..12], Yin::VERSION.to_le_bytes(), "detector version");
    bytes[8..12].copy_from_slice(&(Yin::VERSION + 1).to_le_bytes());
    std::fs::write(&cache, &bytes).unwrap();
    let third = computing(ask(&app, song).await);
    assert_eq!(ended(&mut ws, third).await.0, JobState::Done);
    assert_eq!(
        std::fs::read(&cache).unwrap()[8..12],
        Yin::VERSION.to_le_bytes()
    );
    assert_eq!(download(&app, song).await.len(), frames.len());

    // No Song changed: the index still has the Song as it was.
    let detail: SongDetail = app.get_json(&format!("/api/songs/{}", song.0)).await;
    assert_eq!(detail.path, SINE_MELODY);
}

#[tokio::test]
async fn an_unknown_song_has_no_track() {
    let tools = stand_in_ffmpeg();
    mark(&tools, "open-loudness");
    let app = start(&tools).await;
    let response = app
        .http()
        .post(app.url("/api/songs/999999/pitch-track"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    let response = app
        .http()
        .get(app.url("/api/songs/999999/pitch-track"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    assert_eq!(pitch_track_jobs(&app).await, []);
}

#[tokio::test]
async fn the_job_records_the_loudness_the_index_lacks() {
    let tools = stand_in_ffmpeg();
    let app = start(&tools).await;
    let song = sine_melody(&app).await;

    // The scan's measurements wait at the gate: cancel them all, so the
    // index has no loudness for any Song.
    let measurements: Vec<JobId> = app
        .get_json::<JobList>("/api/jobs")
        .await
        .jobs
        .into_iter()
        .filter(|job| job.kind == JobKind::Loudness)
        .map(|job| job.id)
        .collect();
    assert!(!measurements.is_empty());
    for id in &measurements {
        app.http()
            .post(app.url(&format!("/api/test/jobs/{}/cancel", id.0)))
            .send()
            .await
            .unwrap();
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let jobs = app.get_json::<JobList>("/api/jobs").await.jobs;
        if jobs
            .iter()
            .filter(|job| job.kind == JobKind::Loudness)
            .all(|job| matches!(job.state, JobState::Failed { .. }))
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the measurements end"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let detail: SongDetail = app.get_json(&format!("/api/songs/{}", song.0)).await;
    assert_eq!(detail.loudness_lufs, None);

    mark(&tools, "open-loudness");
    let mut ws = app.connect_ws().await;
    let job = computing(ask(&app, song).await);
    assert_eq!(ended(&mut ws, job).await.0, JobState::Done);

    let detail: SongDetail = app.get_json(&format!("/api/songs/{}", song.0)).await;
    let lufs = detail.loudness_lufs.expect("the job measured the loudness");
    assert!(lufs.is_finite() && lufs < 0.0, "{lufs}");
    let loudness_jobs = app
        .get_json::<JobList>("/api/jobs")
        .await
        .jobs
        .into_iter()
        .filter(|job| job.kind == JobKind::Loudness)
        .count();
    assert_eq!(loudness_jobs, measurements.len(), "no measurement job ran");
}

#[tokio::test]
async fn a_timeout_or_a_failure_reports_the_pitch_track_code() {
    let tools = stand_in_ffmpeg();
    mark(&tools, "open-loudness");
    mark(&tools, "hang");
    let app = start(&tools).await;
    let song = sine_melody(&app).await;
    let mut ws = app.connect_ws().await;

    let job = computing(
        request(
            &app,
            &format!("/api/test/songs/{}/pitch-track?timeoutMs=500", song.0),
        )
        .await,
    );
    assert_eq!(
        ended(&mut ws, job).await.0,
        JobState::Failed {
            reason: UserMessage::PitchTrackFailed
        }
    );
    assert!(!cache_file(&app, song).exists());

    // ffmpeg fails: the same code, through the real endpoint.
    std::fs::remove_file(tools.path().join("hang")).unwrap();
    mark(&tools, "fail");
    let job = computing(ask(&app, song).await);
    assert_eq!(
        ended(&mut ws, job).await.0,
        JobState::Failed {
            reason: UserMessage::PitchTrackFailed
        }
    );
    let response = app
        .http()
        .get(app.url(&format!("/api/songs/{}/pitch-track", song.0)))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404, "no track to download");
}
