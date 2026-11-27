//! Each Song's loudness (EBU R128 integrated, in LUFS), measured by jobs in
//! the ffmpeg lane over the Song's original audio file, through the real app
//! over HTTP and WebSocket with the real ffmpeg on tiny media generated at
//! test time.
//!
//! A stand-in `ffmpeg` first on the app's `PATH` writes each input file it
//! is given to a log, then waits for a gate file before it runs the real one,
//! so the tests can look at a Song before it is measured and see the order
//! of the measurements. ffprobe stays the real one.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use openstar_protocol::jobs::{JobKind, JobList, JobState};
use openstar_protocol::library::{ScanStatus, SongDetail, SongId, SongList};
use openstar_protocol::{ClientMessage, ServerMessage};
use openstar_test_harness::{AppFolders, Media, TestApp, placeholder_media};

const BODY: &str = "#BPM:200\n: 0 4 0 La\nE\n";

fn write_song(folder: &Path, title: &str, audio: &str) {
    std::fs::create_dir_all(folder).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:A\n#TITLE:{title}\n#MP3:{audio}\n{BODY}"),
    )
    .unwrap();
}

/// The real program `name` on the test process's `PATH`.
fn real(name: &str) -> PathBuf {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
        .unwrap_or_else(|| panic!("{name} is not installed"))
}

/// A folder with an `ffmpeg` that logs the file after its `-i` to `calls`,
/// waits until `open` exists beside it, then runs the real one.
fn gated_ffmpeg() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let script = format!(
        "#!/bin/sh\n\
         prev=''\n\
         for arg in \"$@\"; do\n\
           if [ \"$prev\" = '-i' ]; then echo \"$arg\" >> '{calls}'; fi\n\
           prev=\"$arg\"\n\
         done\n\
         while [ ! -e '{open}' ]; do sleep 0.02; done\n\
         exec '{ffmpeg}' \"$@\"\n",
        calls = dir.path().join("calls").display(),
        open = dir.path().join("open").display(),
        ffmpeg = real("ffmpeg").display(),
    );
    let path = dir.path().join("ffmpeg");
    openstar_test_harness::write_executable(&path, &script).unwrap();
    dir
}

fn open_gate(tools: &tempfile::TempDir) {
    std::fs::write(tools.path().join("open"), b"").unwrap();
}

/// The input files the stand-in ffmpeg was started on, in order.
fn calls(tools: &tempfile::TempDir) -> Vec<String> {
    std::fs::read_to_string(tools.path().join("calls"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

async fn eventually<T>(what: &str, mut check: impl AsyncFnMut() -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(value) = check().await {
            return value;
        }
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn song_id(app: &TestApp, title: &str) -> SongId {
    app.get_json::<SongList>("/api/songs")
        .await
        .songs
        .into_iter()
        .find(|s| s.title == title)
        .unwrap_or_else(|| panic!("{title} is listed"))
        .id
}

async fn detail(app: &TestApp, title: &str) -> SongDetail {
    let id = song_id(app, title).await;
    app.get_json(&format!("/api/songs/{}", id.0)).await
}

async fn measurements(app: &TestApp) -> Vec<JobState> {
    app.get_json::<JobList>("/api/jobs")
        .await
        .jobs
        .into_iter()
        .filter(|job| job.kind == JobKind::Loudness)
        .map(|job| job.state)
        .collect()
}

/// Waits until no measurement is queued or running; returns them all.
async fn measurements_ended(app: &TestApp) -> Vec<JobState> {
    eventually("the measurements end", async || {
        let states = measurements(app).await;
        states
            .iter()
            .all(|s| matches!(s, JobState::Done | JobState::Failed { .. }))
            .then_some(states)
    })
    .await
}

async fn rescanned(app: &TestApp) {
    let before: ScanStatus = app.get_json("/api/library/scan").await;
    let response = app
        .http()
        .post(app.url("/api/library/rescan"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    eventually("the Rescan ends", async || {
        let status: ScanStatus = app.get_json("/api/library/scan").await;
        (!status.running && status.finished > before.finished).then_some(())
    })
    .await;
}

/// Every file under `dir`, relative, with its bytes.
fn snapshot(dir: &Path) -> BTreeSet<(PathBuf, Vec<u8>)> {
    let mut all = BTreeSet::new();
    let mut folders = vec![dir.to_owned()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                folders.push(path);
            } else {
                let bytes = std::fs::read(&path).unwrap();
                all.insert((path.strip_prefix(dir).unwrap().to_owned(), bytes));
            }
        }
    }
    all
}

#[tokio::test]
async fn a_generated_tone_is_measured_in_lufs_and_again_when_it_changes() {
    let media = Media::new();
    let folders = AppFolders::new();
    // A 1 kHz sine at 1/8 of full scale, mono: −3.01 LUFS for full scale,
    // so −21.07 LUFS (EBU Tech 3341's reference signal, scaled).
    let tone = media.tone("tone.wav", 1000.0, 2.0, 48_000).unwrap();
    let folder = folders.songs_dir().join("Tone");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::copy(&tone, folder.join("tone.wav")).unwrap();
    write_song(&folder, "Tone", "tone.wav");
    let ffmpeg = gated_ffmpeg();
    let app = TestApp::builder()
        .folders(folders)
        .tools_first(ffmpeg.path())
        .start()
        .await;
    let library_before = snapshot(app.songs_dir());

    // Not measured yet: listed, queueable, and its detail says so.
    let unmeasured = detail(&app, "Tone").await;
    assert_eq!(unmeasured.loudness_lufs, None);
    assert!(!unmeasured.preparing, "never preparing for its loudness");

    open_gate(&ffmpeg);
    let states = measurements_ended(&app).await;
    assert_eq!(states, [JobState::Done]);
    let lufs = detail(&app, "Tone").await.loudness_lufs.expect("measured");
    assert!((lufs - -21.07).abs() < 0.2, "measured {lufs} LUFS");
    assert_eq!(
        calls(&ffmpeg)
            .iter()
            .filter(|input| input.ends_with("tone.wav"))
            .count(),
        1
    );
    assert!(
        calls(&ffmpeg)
            .iter()
            .all(|input| input == &app.songs_dir().join("Tone/tone.wav").display().to_string()),
        "the original audio file, never a cache copy: {:?}",
        calls(&ffmpeg)
    );
    assert_eq!(snapshot(app.songs_dir()), library_before, "nothing written");

    // Unchanged: not measured again.
    rescanned(&app).await;
    assert_eq!(measurements_ended(&app).await.len(), 1);

    // A new mtime: measured again.
    let audio = std::fs::File::options()
        .write(true)
        .open(app.songs_dir().join("Tone/tone.wav"))
        .unwrap();
    audio
        .set_modified(std::time::SystemTime::now() + Duration::from_secs(5))
        .unwrap();
    drop(audio);
    rescanned(&app).await;
    let states = measurements_ended(&app).await;
    assert_eq!(states, [JobState::Done, JobState::Done]);
    let again = detail(&app, "Tone").await.loudness_lufs.expect("measured");
    assert!((again - lufs).abs() < 0.01);

    // A new size: measured again, the quieter file lower.
    let quiet = media.noise("quiet.wav", 0.01, 2.0, 48_000).unwrap();
    std::fs::copy(&quiet, app.songs_dir().join("Tone/tone.wav")).unwrap();
    rescanned(&app).await;
    assert_eq!(measurements_ended(&app).await.len(), 3);
    let quieter = detail(&app, "Tone").await.loudness_lufs.expect("measured");
    assert!(quieter < lufs - 10.0, "{quieter} LUFS after {lufs}");
}

#[tokio::test]
async fn a_queued_unmeasured_song_is_measured_before_the_others() {
    let folders = AppFolders::new();
    for title in ["A", "B", "C", "D", "E"] {
        let folder = folders.songs_dir().join(title);
        placeholder_media(&folder.join("song.mp3")).unwrap();
        write_song(&folder, title, "song.mp3");
    }
    let ffmpeg = gated_ffmpeg();
    let app = TestApp::builder()
        .folders(folders)
        .tools_first(ffmpeg.path())
        .start()
        .await;

    // Two measurements run (the lane's cap) and wait at the gate.
    eventually("two measurements start", async || {
        (calls(&ffmpeg).len() == 2).then_some(())
    })
    .await;
    let first_two = calls(&ffmpeg);

    let mut stage = app.connect_stage().await;
    let last = ["A", "B", "C", "D", "E"]
        .into_iter()
        .rev()
        .find(|t| {
            !first_two
                .iter()
                .any(|c| c.ends_with(&format!("/{t}/song.mp3")))
        })
        .unwrap();
    stage
        .send(&ClientMessage::AddRequest {
            song_id: song_id(&app, last).await,
            requested_players: None,
        })
        .await;
    loop {
        if let ServerMessage::PartyChanged { party, .. } = stage.recv().await
            && !party.queue.is_empty()
        {
            break;
        }
    }

    open_gate(&ffmpeg);
    let states = measurements_ended(&app).await;
    assert_eq!(states.len(), 5);
    assert!(states.iter().all(|s| *s == JobState::Done), "{states:?}");
    let order = calls(&ffmpeg);
    assert_eq!(order.len(), 5, "{order:?}");
    // Once the gate opens, both slots of the lane start a measurement at
    // once: the queued Song is claimed first, but the two ffmpeg starts may
    // reach the call log in either order. By path it would be the last of
    // all five.
    assert!(
        order[2..4]
            .iter()
            .any(|call| call.ends_with(&format!("/{last}/song.mp3"))),
        "the queued Song {last} goes next: {order:?}"
    );
    for title in ["A", "B", "C", "D", "E"] {
        assert!(
            detail(&app, title).await.loudness_lufs.is_some(),
            "{title} is measured"
        );
    }
}
