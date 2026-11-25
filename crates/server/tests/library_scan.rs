//! The Library scan and its index, through the real app over HTTP and the
//! WebSocket, on a copy of `fixtures/library-scan/` (see its README for what each
//! `.txt` covers). Media files are created empty at test time.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use openstar_protocol::library::{
    FileProblem, LibraryProblem, ProblemReason, ProblemSeverity, ScanReport, ScanStatus,
    SongDetail, SongSummary,
};
use openstar_protocol::song::TxtRejection;
use openstar_protocol::{ChangeTopic, ServerMessage};
use openstar_test_harness::{AppFolders, TestApp};

/// How many `.txt` candidates the fixture Library holds.
const CANDIDATES: u32 = 9;

fn fixture_library() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/library-scan")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Folders whose Library is a copy of the fixture Library with its media.
fn library_folders() -> AppFolders {
    let folders = AppFolders::new();
    let songs = folders.songs_dir();
    copy_dir(&fixture_library(), songs);
    let list = std::fs::read_to_string(fixture_library().join("media.list")).unwrap();
    for line in list
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        let path = songs.join(line);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }
    folders
}

async fn start_on_library() -> TestApp {
    TestApp::builder().folders(library_folders()).start().await
}

/// Waits until `finished` scans have finished since the start, and returns
/// the last one's report. Generous, because other builds may load the machine.
async fn scanned(app: &TestApp, finished: u32) -> ScanReport {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let status: ScanStatus = app.get_json("/api/library/scan").await;
        if !status.running && status.finished >= finished {
            return status.last.expect("a finished scan has a report");
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "scan {finished} did not finish within 30 s: {status:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn rescan(app: &TestApp) -> ScanStatus {
    let response = app
        .http()
        .post(app.url("/api/library/rescan"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    response.json().await.unwrap()
}

async fn song_paths(app: &TestApp) -> BTreeSet<String> {
    let songs: Vec<SongSummary> = app.get_json("/api/songs").await;
    songs.into_iter().map(|s| s.path).collect()
}

async fn song(app: &TestApp, path: &str) -> SongDetail {
    let songs: Vec<SongSummary> = app.get_json("/api/songs").await;
    let id = songs
        .iter()
        .find(|s| s.path == path)
        .unwrap_or_else(|| panic!("{path} is not in the Song list"))
        .id;
    app.get_json(&format!("/api/songs/{}", id.0)).await
}

async fn problems(app: &TestApp) -> Vec<LibraryProblem> {
    app.get_json("/api/library/problems").await
}

fn audio_not_found(header: &str, reference: &str) -> ProblemReason {
    ProblemReason::File(FileProblem::AudioNotFound {
        header: header.into(),
        reference: reference.into(),
    })
}

fn rejection(path: &str, reason: ProblemReason) -> LibraryProblem {
    LibraryProblem {
        path: path.into(),
        severity: ProblemSeverity::Rejection,
        reason,
    }
}

fn media_not_found(path: &str, header: &str, reference: &str) -> LibraryProblem {
    LibraryProblem {
        path: path.into(),
        severity: ProblemSeverity::Warning,
        reason: ProblemReason::File(FileProblem::MediaNotFound {
            header: header.into(),
            reference: reference.into(),
        }),
    }
}

fn set(paths: &[&str]) -> BTreeSet<String> {
    paths.iter().map(|p| (*p).to_owned()).collect()
}

#[tokio::test]
async fn the_first_scan_lists_every_playable_song_at_any_depth() {
    let app = start_on_library().await;
    let report = scanned(&app, 1).await;
    assert_eq!(
        report,
        ScanReport {
            read: CANDIDATES,
            unchanged: 0,
            removed: 0
        }
    );
    // References in other case (`AUDIO.MP3`, `MEDIA/Track.Ogg`) are found;
    // `first.txt.orig` is no candidate; two `.txt` in one folder are two Songs.
    assert_eq!(
        song_paths(&app).await,
        set(&[
            "Nested/Deeper/Second/second.txt",
            "Placeholder Artist - First Song/first.txt",
            "Two In One/duet.txt",
            "Two In One/solo.txt",
        ])
    );
}

#[tokio::test]
async fn rejections_and_warnings_are_listed_as_library_problems() {
    let app = start_on_library().await;
    scanned(&app, 1).await;
    let problems = problems(&app).await;
    let expected = [
        rejection(
            "Missing Audio/missing.txt",
            audio_not_found("MP3", "not-there.mp3"),
        ),
        rejection(
            "No Audio/no-audio.txt",
            ProblemReason::File(FileProblem::MissingAudioReference),
        ),
        rejection(
            "Escapes/outside.txt",
            audio_not_found("MP3", "../../outside.mp3"),
        ),
        rejection(
            "Escapes/absolute.txt",
            audio_not_found("MP3", "/etc/hostname"),
        ),
        rejection(
            "readme.txt",
            ProblemReason::Rejection(TxtRejection::MissingBpm),
        ),
        media_not_found(
            "Placeholder Artist - First Song/first.txt",
            "BACKGROUND",
            "missing-background.jpg",
        ),
        media_not_found(
            "Nested/Deeper/Second/second.txt",
            "VIDEO",
            "media/missing-video.mp4",
        ),
    ];
    for problem in &expected {
        assert!(
            problems.contains(problem),
            "{problem:?} missing from {problems:#?}"
        );
    }
    assert_eq!(problems.len(), expected.len(), "{problems:#?}");
    assert!(!problems.iter().any(|p| p.path.ends_with(".orig")));
}

#[tokio::test]
async fn a_song_detail_is_the_parsed_song_in_seconds_and_real_beats() {
    let app = start_on_library().await;
    scanned(&app, 1).await;
    let detail = song(&app, "Placeholder Artist - First Song/first.txt").await;
    assert_eq!(detail.song.headers.title, "First Song");
    assert_eq!(detail.song.headers.beats_per_minute, 1200.0);
    assert_eq!(detail.song.headers.gap_seconds, 1.5);
    assert_eq!(detail.song.voices.len(), 1);
    assert_eq!(
        detail.warnings,
        vec![ProblemReason::File(FileProblem::MediaNotFound {
            header: "BACKGROUND".into(),
            reference: "missing-background.jpg".into(),
        })]
    );
    let duet = song(&app, "Two In One/duet.txt").await;
    assert_eq!(duet.song.voices.len(), 2);

    let unknown = app
        .http()
        .get(app.url("/api/songs/4000000"))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 404);
}

#[tokio::test]
async fn a_rescan_rereads_only_new_and_changed_files_and_drops_gone_ones() {
    let app = start_on_library().await;
    scanned(&app, 1).await;
    let songs = app.songs_dir().to_owned();

    let mut ws = app.connect_ws().await;
    assert!(matches!(ws.recv().await, ServerMessage::LiveState { .. }));

    // Changed size: re-read.
    let solo = songs.join("Two In One/solo.txt");
    let text = std::fs::read_to_string(&solo).unwrap();
    std::fs::write(&solo, text.replace("Solo Take", "Solo Take Two")).unwrap();
    // Same size and mtime, different bytes: not re-read.
    let duet = songs.join("Two In One/duet.txt");
    let mtime = std::fs::metadata(&duet).unwrap().modified().unwrap();
    let text = std::fs::read_to_string(&duet).unwrap();
    std::fs::write(&duet, text.replace("Duet Take", "Duet Fake")).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&duet)
        .unwrap()
        .set_modified(mtime)
        .unwrap();
    // Gone: removed.
    std::fs::remove_file(songs.join("Missing Audio/missing.txt")).unwrap();
    // New: read.
    std::fs::create_dir_all(songs.join("New")).unwrap();
    std::fs::write(songs.join("New/shared.mp3"), b"").unwrap();
    std::fs::copy(
        songs.join("Two In One/duet.txt"),
        songs.join("New/new duet.txt"),
    )
    .unwrap();

    rescan(&app).await;
    let report = scanned(&app, 2).await;
    assert_eq!(
        report,
        ScanReport {
            read: 2,
            unchanged: CANDIDATES - 2,
            removed: 1
        }
    );
    assert_eq!(
        ws.recv().await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::Library]
        }
    );

    let solo = song(&app, "Two In One/solo.txt").await;
    assert_eq!(solo.song.headers.title, "Solo Take Two");
    let duet = song(&app, "Two In One/duet.txt").await;
    assert_eq!(duet.song.headers.title, "Duet Take");
    let new = song(&app, "New/new duet.txt").await;
    assert_eq!(new.song.headers.title, "Duet Fake");
    assert!(
        !problems(&app)
            .await
            .iter()
            .any(|p| p.path == "Missing Audio/missing.txt")
    );
}

#[tokio::test]
async fn a_restart_serves_the_stored_index_and_rereads_nothing_unchanged() {
    let mut app = start_on_library().await;
    scanned(&app, 1).await;
    let before = song_paths(&app).await;
    app.restart().await;
    let report = scanned(&app, 1).await;
    assert_eq!(
        report,
        ScanReport {
            read: 0,
            unchanged: CANDIDATES,
            removed: 0
        }
    );
    assert_eq!(song_paths(&app).await, before);
}

#[tokio::test]
async fn another_parser_version_in_the_index_rereads_every_file() {
    let mut app = start_on_library().await;
    scanned(&app, 1).await;
    let db =
        rusqlite::Connection::open(app.appdata_dir().join(openstar::db::DATABASE_FILE)).unwrap();
    db.execute(
        "UPDATE library_files SET parser_version = parser_version + 1",
        [],
    )
    .unwrap();
    drop(db);
    app.restart().await;
    let report = scanned(&app, 1).await;
    assert_eq!(report.read, CANDIDATES);
    assert_eq!(report.unchanged, 0);
}

#[tokio::test]
async fn audio_that_appears_later_makes_an_unchanged_txt_playable() {
    let app = start_on_library().await;
    scanned(&app, 1).await;
    std::fs::write(app.songs_dir().join("Missing Audio/NOT-THERE.mp3"), b"").unwrap();
    rescan(&app).await;
    let report = scanned(&app, 2).await;
    assert_eq!(report.read, 0);
    assert!(song_paths(&app).await.contains("Missing Audio/missing.txt"));
}

#[tokio::test]
async fn rescan_needs_no_pin_and_reports_the_scan_state() {
    let app = start_on_library().await;
    scanned(&app, 1).await;
    let status = rescan(&app).await;
    assert!(status.running || status.finished >= 2);
    scanned(&app, 2).await;
}
