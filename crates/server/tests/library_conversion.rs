//! Media the Stage cannot play, converted ahead of time into the appdata
//! cache, through the real app over HTTP and WebSocket with the real ffmpeg
//! on tiny media generated at test time.
//!
//! A stand-in `ffmpeg` first on the app's `PATH` waits for a gate file before
//! it runs the real one, so the tests can look at a Song while it converts;
//! another one always fails. ffprobe stays the real one.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use openstar_protocol::jobs::{JobKind, JobList, JobState};
use openstar_protocol::library::{
    FileProblem, LibraryProblem, MediaFile, ProblemReason, ProblemSeverity, ScanStatus, SongDetail,
    SongList, SongSummary, SongVideo,
};
use openstar_protocol::{ChangeTopic, ClientMessage, ServerMessage, UserMessage};
use openstar_test_harness::{AppFolders, Media, TestApp, WsClient};

const BODY: &str = "#BPM:200\n: 0 4 0 La\nE\n";

fn write_txt(folder: &Path, headers: &str) {
    std::fs::create_dir_all(folder).unwrap();
    std::fs::write(folder.join("song.txt"), format!("{headers}{BODY}")).unwrap();
}

fn copy(from: &Path, folder: &Path, name: &str) {
    std::fs::create_dir_all(folder).unwrap();
    std::fs::copy(from, folder.join(name)).unwrap();
}

/// The real program `name` on the test process's `PATH`.
fn real(name: &str) -> PathBuf {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
        .unwrap_or_else(|| panic!("{name} is not installed"))
}

/// A folder with a stand-in `ffmpeg` running `script(folder)` (a shell body).
fn tools(script: impl FnOnce(&Path) -> String) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ffmpeg");
    let script = format!("#!/bin/sh\n{}\n", script(dir.path()));
    openstar_test_harness::write_executable(&path, &script).unwrap();
    dir
}

/// An `ffmpeg` that waits until `open` exists beside it, then runs the real one.
fn gated_ffmpeg() -> tempfile::TempDir {
    let ffmpeg = real("ffmpeg");
    tools(|dir| {
        format!(
            "while [ ! -e '{}' ]; do sleep 0.02; done\nexec '{}' \"$@\"",
            dir.join("open").display(),
            ffmpeg.display()
        )
    })
}

fn open_gate(tools: &tempfile::TempDir) {
    std::fs::write(tools.path().join("open"), b"").unwrap();
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

/// The files in the media cache.
fn cached(app: &TestApp) -> BTreeSet<PathBuf> {
    let dir = app.appdata_dir().join("cache/media");
    std::fs::read_dir(&dir)
        .map(|entries| entries.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}

async fn summary(app: &TestApp, folder: &str) -> Option<SongSummary> {
    let path = format!("{folder}/song.txt");
    app.get_json::<SongList>("/api/songs")
        .await
        .songs
        .into_iter()
        .find(|s| s.path == path)
}

async fn detail(app: &TestApp, folder: &str) -> SongDetail {
    let id = summary(app, folder).await.expect("listed").id;
    app.get_json(&format!("/api/songs/{}", id.0)).await
}

async fn conversions(app: &TestApp) -> Vec<JobState> {
    app.get_json::<JobList>("/api/jobs")
        .await
        .jobs
        .into_iter()
        .filter(|job| job.kind == JobKind::Conversion)
        .map(|job| job.state)
        .collect()
}

/// Waits until no conversion job is queued or running.
async fn conversions_ended(app: &TestApp) -> Vec<JobState> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let states = conversions(app).await;
        if states
            .iter()
            .all(|s| matches!(s, JobState::Done | JobState::Failed { .. }))
        {
            return states;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "conversions did not end: {states:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
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
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let status: ScanStatus = app.get_json("/api/library/scan").await;
        if !status.running && status.finished > before.finished {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the Rescan did not end"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn fetch(app: &TestApp, url: &str) -> Vec<u8> {
    let response = app.http().get(app.url(url)).send().await.unwrap();
    assert_eq!(response.status(), 200, "{url}");
    response.bytes().await.unwrap().to_vec()
}

/// ffprobe's answer for `bytes`: container, then `codec_type:codec_name:pix_fmt:width:height` per stream.
fn probe(bytes: &[u8]) -> (String, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("served");
    std::fs::write(&file, bytes).unwrap();
    let output = std::process::Command::new(real("ffprobe"))
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(&file)
        .output()
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let streams = json["streams"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            format!(
                "{}:{}:{}",
                s["codec_type"].as_str().unwrap_or(""),
                s["codec_name"].as_str().unwrap_or(""),
                s["pix_fmt"].as_str().unwrap_or("")
            )
        })
        .collect();
    (
        json["format"]["format_name"].as_str().unwrap().to_owned(),
        streams,
    )
}

/// The next `Changed` notice naming the Library.
async fn library_changed(socket: &mut WsClient) {
    loop {
        if let ServerMessage::Changed { topics } = socket.recv().await
            && topics.contains(&ChangeTopic::Library)
        {
            return;
        }
    }
}

/// Songs: "Both" plays one AVI as audio and video; "Split" has Ogg audio and
/// an AVI video; "Plain" has only Ogg audio.
fn library(media: &Media) -> AppFolders {
    let folders = AppFolders::new();
    let songs = folders.songs_dir();
    let avi = media.tiny_video("clip.avi", 1.0).unwrap();
    let ogg = media.tone("tone.ogg", 440.0, 1.0, 44_100).unwrap();
    copy(&avi, &songs.join("Both"), "clip.avi");
    write_txt(
        &songs.join("Both"),
        "#ARTIST:A\n#TITLE:Both\n#MP3:clip.avi\n#VIDEO:clip.avi\n",
    );
    copy(&ogg, &songs.join("Split"), "tone.ogg");
    copy(&avi, &songs.join("Split"), "clip.avi");
    write_txt(
        &songs.join("Split"),
        "#ARTIST:A\n#TITLE:Split\n#MP3:tone.ogg\n#VIDEO:clip.avi\n",
    );
    copy(&ogg, &songs.join("Plain"), "tone.ogg");
    write_txt(
        &songs.join("Plain"),
        "#ARTIST:A\n#TITLE:Plain\n#MP3:tone.ogg\n",
    );
    folders
}

#[tokio::test]
async fn an_avi_is_converted_and_served_from_the_cache() {
    let media = Media::new();
    let ffmpeg = gated_ffmpeg();
    let app = TestApp::builder()
        .folders(library(&media))
        .tools_first(ffmpeg.path())
        .start()
        .await;
    let library_before = snapshot(app.songs_dir());

    // While converting: audio "preparing", not queueable; video not offered.
    let both = summary(&app, "Both").await.expect("a new Song is listed");
    assert!(both.preparing);
    assert!(detail(&app, "Both").await.preparing);
    let split = detail(&app, "Split").await;
    assert!(!split.preparing);
    assert_eq!(
        split.media.video, None,
        "plays over its background or cover"
    );
    assert!(!summary(&app, "Plain").await.unwrap().preparing);
    assert_eq!(conversions(&app).await.len(), 2);

    let mut stage = app.connect_stage().await;
    stage
        .send(&ClientMessage::AddRequest {
            song_id: both.id,
            requested_players: None,
        })
        .await;
    loop {
        if let ServerMessage::Rejected { reason } = stage.recv().await {
            assert_eq!(reason, UserMessage::SongPreparing);
            break;
        }
    }

    // The conversions end: a change notice, and both are served from the cache.
    open_gate(&ffmpeg);
    library_changed(&mut stage).await;
    assert!(
        conversions_ended(&app)
            .await
            .iter()
            .all(|s| *s == JobState::Done)
    );
    let both = detail(&app, "Both").await;
    assert!(!both.preparing);
    assert!(!summary(&app, "Both").await.unwrap().preparing);
    assert!(both.media.audio.native);
    assert_eq!(both.media.video, Some(SongVideo::InAudio));
    let (container, streams) = probe(&fetch(&app, &both.media.audio.url).await);
    assert!(container.contains("mp4"), "{container}");
    assert_eq!(streams, ["video:h264:yuv420p", "audio:aac:"], "H.264 + AAC");

    let split = detail(&app, "Split").await;
    let Some(SongVideo::File {
        file: MediaFile { url, native },
        ..
    }) = &split.media.video
    else {
        panic!("the converted video is offered: {:?}", split.media.video);
    };
    assert!(native);
    let (container, streams) = probe(&fetch(&app, url).await);
    assert!(container.contains("mp4"), "{container}");
    assert_eq!(streams[0], "video:h264:yuv420p");
    // The Ogg audio plays as it is, from the Library.
    assert_eq!(
        fetch(&app, &split.media.audio.url).await,
        std::fs::read(app.songs_dir().join("Split/tone.ogg")).unwrap()
    );

    assert_eq!(
        snapshot(app.songs_dir()),
        library_before,
        "the Library is untouched"
    );
    assert_eq!(cached(&app).len(), 2);

    // Pitch tracks (`cache/pitch/<song id>.bin`, #57): one per Song, and one
    // whose Song is not in the index.
    let pitch = app.appdata_dir().join("cache/pitch");
    std::fs::create_dir_all(&pitch).unwrap();
    let ids = [
        summary(&app, "Both").await.unwrap().id.0,
        summary(&app, "Split").await.unwrap().id.0,
        summary(&app, "Plain").await.unwrap().id.0,
    ];
    for id in ids {
        std::fs::write(pitch.join(format!("{id}.bin")), b"track").unwrap();
    }
    std::fs::write(pitch.join("99999.bin"), b"track").unwrap();

    // The video source goes: its cache entry goes, the Song plays without it.
    let split_cache = cached(&app);
    std::fs::remove_file(app.songs_dir().join("Split/clip.avi")).unwrap();
    rescanned(&app).await;
    assert_eq!(cached(&app).len(), 1);
    assert_eq!(detail(&app, "Split").await.media.video, None);

    // The audio source changes: converted again into a new entry, and its
    // Song's Pitch track is removed with the stale one.
    std::fs::copy(
        media.tiny_video("longer.avi", 1.5).unwrap(),
        app.songs_dir().join("Both/clip.avi"),
    )
    .unwrap();
    rescanned(&app).await;
    assert!(
        cached(&app).is_disjoint(&split_cache),
        "the old entries are gone"
    );
    let pitch_left: BTreeSet<String> = std::fs::read_dir(&pitch)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        pitch_left,
        BTreeSet::from([format!("{}.bin", ids[1]), format!("{}.bin", ids[2])]),
        "the changed audio's and the orphan's tracks are removed"
    );
    conversions_ended(&app).await;
    assert_eq!(cached(&app).len(), 1);
    let both = detail(&app, "Both").await;
    assert!(!both.preparing);
    let length = both.length_seconds.unwrap();
    assert!((1.4..1.7).contains(&length), "{length}");
    let (_, streams) = probe(&fetch(&app, &both.media.audio.url).await);
    assert_eq!(streams[0], "video:h264:yuv420p");

    // The audio source goes: the Song leaves, and so does its cache entry.
    std::fs::remove_file(app.songs_dir().join("Both/clip.avi")).unwrap();
    rescanned(&app).await;
    assert!(cached(&app).is_empty());
    assert!(summary(&app, "Both").await.is_none());
}

#[tokio::test]
async fn media_that_cannot_be_converted_is_a_library_problem() {
    let media = Media::new();
    let ffmpeg = tools(|_| "echo 'cannot convert' >&2\nexit 1".to_owned());
    let app = TestApp::builder()
        .folders(library(&media))
        .tools_first(ffmpeg.path())
        .start()
        .await;
    let states = conversions_ended(&app).await;
    assert_eq!(states.len(), 2);
    assert!(states.iter().all(|s| matches!(s, JobState::Failed { .. })));

    // Audio: a rejection; the Song is not listed.
    assert!(summary(&app, "Both").await.is_none());
    // Video: a warning; the Song plays over its background or cover.
    let split = detail(&app, "Split").await;
    assert_eq!(split.media.video, None);
    let warning = ProblemReason::File(FileProblem::VideoNotConverted {
        file: "Split/clip.avi".into(),
    });
    assert!(split.warnings.contains(&warning), "{:?}", split.warnings);
    assert!(!summary(&app, "Split").await.unwrap().has_video);

    let problems: Vec<LibraryProblem> = app.get_json("/api/library/problems").await;
    assert!(problems.contains(&LibraryProblem {
        path: "Both/song.txt".into(),
        severity: ProblemSeverity::Rejection,
        reason: ProblemReason::File(FileProblem::AudioNotConverted {
            file: "Both/clip.avi".into(),
        }),
    }));
    assert!(problems.contains(&LibraryProblem {
        path: "Split/song.txt".into(),
        severity: ProblemSeverity::Warning,
        reason: warning,
    }));
    assert!(cached(&app).is_empty());

    // Not tried again at the next scan while the source is unchanged.
    rescanned(&app).await;
    assert_eq!(conversions(&app).await.len(), 2);
    assert!(summary(&app, "Both").await.is_none());
}
