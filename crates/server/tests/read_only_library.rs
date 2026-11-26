//! Playing from a read-only Library (#192), through the real app over HTTP
//! and WebSocket. The songs folder is made read-only the way a read-only
//! mount looks to OpenStar (no folder or file in it can be written), then
//! the app starts on it: everything that writes only to `/appdata` keeps
//! working (Songs are listed, served and taken into the Queue; scanning,
//! Rescan, conversion and loudness), while saving a Timing edit, Restore
//! Original, deleting a Song and restoring from the trash are refused with
//! `409 libraryReadOnly` with or without an Unlock, and nothing on disk
//! changes.
//!
//! These tests skip when the process can write to read-only folders anyway
//! (running as root).

use std::collections::BTreeSet;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use openstar_protocol::admin::{ApiError, ApiErrorCode};
use openstar_protocol::jobs::{JobKind, JobList, JobState};
use openstar_protocol::library::{ScanStatus, SongDetail, SongId, SongList, SongVideo, TrashList};
use openstar_protocol::song::{TimingEdit, TimingOperation, TimingPreview, TimingSave};
use openstar_protocol::{
    ClientMessage, LibraryReadOnly, LibraryReadOnlyCode, ServerInfo, ServerMessage,
};
use openstar_test_harness::{AppFolders, Media, TestApp};
use reqwest::StatusCode;

const BODY: &str = "#BPM:200\n: 0 4 0 La\nE\n";

fn write_song(folder: &Path, title: &str, audio: &Path, video: Option<&str>) {
    std::fs::create_dir_all(folder).unwrap();
    let name = audio.file_name().unwrap().to_str().unwrap();
    std::fs::copy(audio, folder.join(name)).unwrap();
    let video = video.map_or(String::new(), |v| format!("#VIDEO:{v}\n"));
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:Placeholder\n#TITLE:{title}\n#MP3:{name}\n{video}{BODY}"),
    )
    .unwrap();
}

/// Every folder and file below `dir` (and `dir`) set to `folder`/`file` modes.
fn set_modes(dir: &Path, folder: u32, file: u32) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            set_modes(&path, folder, file);
        } else {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(file)).unwrap();
        }
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(folder)).unwrap();
}

/// The songs folder, read-only while this lives; writable again on drop, so
/// its temporary folder can be removed.
struct ReadOnly(PathBuf);

impl ReadOnly {
    /// Makes `dir` read-only. `None` when this process can still write there
    /// (root): the caller skips its test.
    fn make(dir: &Path) -> Option<Self> {
        set_modes(dir, 0o555, 0o444);
        let guard = Self(dir.to_owned());
        let probe = dir.join("probe");
        if std::fs::write(&probe, b"x").is_ok() {
            let _ = std::fs::remove_file(probe);
            eprintln!("skipping: this process can write to read-only folders (root?)");
            return None;
        }
        Some(guard)
    }

    /// Lets `f` change the Library on disk, as the owner would by hand.
    fn writable_for(&self, f: impl FnOnce(&Path)) {
        set_modes(&self.0, 0o755, 0o644);
        f(&self.0);
        set_modes(&self.0, 0o555, 0o444);
    }
}

impl Drop for ReadOnly {
    fn drop(&mut self) {
        set_modes(&self.0, 0o755, 0o644);
    }
}

/// Every file under `dir`, relative, with its bytes.
fn snapshot(dir: &Path) -> BTreeSet<(PathBuf, Vec<u8>)> {
    let mut all = BTreeSet::new();
    let mut folders = vec![dir.to_owned()];
    while let Some(folder) = folders.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
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

async fn song_id(app: &TestApp, title: &str) -> Option<SongId> {
    let songs = app.get_json::<SongList>("/api/songs").await.songs;
    songs.into_iter().find(|s| s.title == title).map(|s| s.id)
}

async fn detail(app: &TestApp, title: &str) -> SongDetail {
    let id = song_id(app, title).await.expect("listed");
    app.get_json(&format!("/api/songs/{}", id.0)).await
}

async fn jobs(app: &TestApp, kind: JobKind) -> Vec<JobState> {
    app.get_json::<JobList>("/api/jobs")
        .await
        .jobs
        .into_iter()
        .filter(|job| job.kind == kind)
        .map(|job| job.state)
        .collect()
}

/// Waits until no job of `kind` is queued or running, and returns their states.
async fn jobs_ended(app: &TestApp, kind: JobKind) -> Vec<JobState> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let states = jobs(app, kind).await;
        if states
            .iter()
            .all(|s| matches!(s, JobState::Done | JobState::Failed { .. }))
        {
            return states;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{kind:?} jobs did not end: {states:?}"
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
    assert_eq!(response.status(), StatusCode::ACCEPTED);
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
    assert_eq!(response.status(), StatusCode::OK, "{url}");
    response.bytes().await.unwrap().to_vec()
}

fn read_only_info(app: &TestApp) -> LibraryReadOnly {
    LibraryReadOnly {
        code: LibraryReadOnlyCode::SongsFolderNotWritable,
        songs_dir: app.songs_dir().display().to_string(),
    }
}

#[tokio::test]
async fn a_read_only_library_plays_scans_converts_and_measures() {
    let media = Media::new();
    let folders = AppFolders::new();
    let songs = folders.songs_dir().to_owned();
    let mp3 = media.tone("tone.mp3", 440.0, 1.0, 44_100).unwrap();
    let avi = media.tiny_video("clip.avi", 1.0).unwrap();
    write_song(&songs.join("Plain"), "Plain", &mp3, None);
    write_song(&songs.join("Moving"), "Moving", &avi, Some("clip.avi"));
    let Some(read_only) = ReadOnly::make(&songs) else {
        return;
    };
    let library_before = snapshot(&songs);
    let app = TestApp::builder().folders(folders).start().await;

    let info: ServerInfo = app.get_json("/api/server-info").await;
    assert_eq!(info.library_read_only, Some(read_only_info(&app)));

    // The start-up scan indexed both Songs; the AVI converts into the
    // appdata cache and every audio file is measured.
    assert!(
        jobs_ended(&app, JobKind::Conversion)
            .await
            .iter()
            .all(|s| *s == JobState::Done)
    );
    assert!(
        jobs_ended(&app, JobKind::Loudness)
            .await
            .iter()
            .all(|s| *s == JobState::Done)
    );
    let plain = detail(&app, "Plain").await;
    assert!(!plain.preparing);
    assert!(plain.loudness_lufs.is_some(), "measured");
    assert_eq!(
        fetch(&app, &plain.media.audio.url).await,
        std::fs::read(songs.join("Plain/tone.mp3")).unwrap(),
        "served from the Library as it is"
    );
    let moving = detail(&app, "Moving").await;
    assert!(!moving.preparing);
    assert!(moving.media.audio.native, "served from the conversion");
    assert_eq!(moving.media.video, Some(SongVideo::InAudio));
    assert!(!fetch(&app, &moving.media.audio.url).await.is_empty());
    assert!(
        std::fs::read_dir(app.appdata_dir().join("cache/media"))
            .unwrap()
            .next()
            .is_some(),
        "the conversion went to the appdata cache"
    );

    // The Stage takes a Song into the Queue.
    let mut stage = app.connect_stage().await;
    stage
        .send(&ClientMessage::AddRequest {
            song_id: plain.id,
            requested_players: None,
        })
        .await;
    loop {
        match stage.recv().await {
            ServerMessage::PartyChanged { party, .. }
                if party.queue.iter().any(|r| r.song_id == plain.id) =>
            {
                break;
            }
            ServerMessage::Rejected { reason } => panic!("refused: {reason:?}"),
            _ => {}
        }
    }
    assert_eq!(snapshot(&songs), library_before, "the Library is untouched");

    // A Song the owner adds by hand shows after a Rescan.
    read_only.writable_for(|songs| write_song(&songs.join("Added"), "Added", &mp3, None));
    rescanned(&app).await;
    assert!(song_id(&app, "Added").await.is_some());
    let info: ServerInfo = app.get_json("/api/server-info").await;
    assert_eq!(
        info.library_read_only,
        Some(read_only_info(&app)),
        "still read-only after a Rescan"
    );
    app.stop().await;
    drop(read_only);
}

/// The answer to `request`: status and the API error code, if any.
async fn answer(request: reqwest::RequestBuilder) -> (StatusCode, Option<ApiErrorCode>) {
    let response = request.send().await.unwrap();
    let status = response.status();
    let code = response.json::<ApiError>().await.ok().map(|e| e.code);
    (status, code)
}

#[tokio::test]
async fn a_read_only_library_refuses_each_write_whatever_the_unlock() {
    let media = Media::new();
    let mp3 = media.tone("tone.mp3", 440.0, 1.0, 44_100).unwrap();

    // While writable: two Songs, one with an Original, a third in the trash.
    let mut app = TestApp::start().await;
    let songs = app.songs_dir().to_owned();
    write_song(&songs.join("Kept"), "Kept", &mp3, None);
    std::fs::copy(
        songs.join("Kept/song.txt"),
        songs.join("Kept/song.txt.orig"),
    )
    .unwrap();
    write_song(&songs.join("Gone"), "Gone", &mp3, None);
    app.restart().await;
    let cookie = app.unlock().await;
    let gone = song_id(&app, "Gone").await.unwrap();
    let response = app
        .http()
        .delete(app.url(&format!("/api/songs/{}", gone.0)))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let trashed = app.get_json::<TrashList>("/api/library/trash").await.songs;
    let trash_id = trashed[0].id;

    // The owner mounts the Library read-only and starts OpenStar again.
    let Some(read_only) = ReadOnly::make(&songs) else {
        return;
    };
    app.restart().await;
    let info: ServerInfo = app.get_json("/api/server-info").await;
    assert_eq!(info.library_read_only, Some(read_only_info(&app)));
    let library_before = snapshot(&songs);
    let trash_before = snapshot(&app.appdata_dir().join("trash"));

    let kept = song_id(&app, "Kept").await.unwrap();
    let originals: Vec<SongId> = app.get_json("/api/library/originals").await;
    assert_eq!(originals, vec![kept]);
    // The preview writes nothing, so it still answers.
    let preview = app
        .http()
        .post(app.url(&format!("/api/songs/{}/timing/preview", kept.0)))
        .json(&TimingEdit {
            operations: vec![TimingOperation::SetGap { seconds: 0.25 }],
        })
        .send()
        .await
        .unwrap();
    assert_eq!(preview.status(), StatusCode::OK);
    let preview: TimingPreview = preview.json().await.unwrap();

    let cookie = app.unlock().await;
    let writes: Vec<(&str, reqwest::Method, String, Option<serde_json::Value>)> = vec![
        (
            "save a Timing edit",
            reqwest::Method::POST,
            format!("/api/songs/{}/timing", kept.0),
            Some(
                serde_json::to_value(TimingSave {
                    base: preview.base.clone(),
                    operations: vec![TimingOperation::SetGap { seconds: 0.25 }],
                    auto_fit_from: None,
                    opened_at_ms: None,
                })
                .unwrap(),
            ),
        ),
        (
            "Restore Original",
            reqwest::Method::POST,
            format!("/api/songs/{}/restore-original", kept.0),
            None,
        ),
        (
            "delete a Song",
            reqwest::Method::DELETE,
            format!("/api/songs/{}", kept.0),
            None,
        ),
        (
            "restore from the trash",
            reqwest::Method::POST,
            format!("/api/library/trash/{}/restore", trash_id.0),
            None,
        ),
    ];
    for (what, method, path, body) in writes {
        for unlock in [Some(cookie.as_str()), None] {
            let mut request = app.http().request(method.clone(), app.url(&path));
            if let Some(cookie) = unlock {
                request = request.header("cookie", cookie);
            }
            if let Some(body) = &body {
                request = request.json(body);
            }
            assert_eq!(
                answer(request).await,
                (StatusCode::CONFLICT, Some(ApiErrorCode::LibraryReadOnly)),
                "{what}, unlocked: {}",
                unlock.is_some()
            );
        }
    }

    assert_eq!(snapshot(&songs), library_before, "the Library is untouched");
    assert_eq!(
        snapshot(&app.appdata_dir().join("trash")),
        trash_before,
        "the trash is untouched"
    );
    assert!(song_id(&app, "Kept").await.is_some());
    assert_eq!(
        app.get_json::<TrashList>("/api/library/trash").await.songs,
        trashed
    );
    app.stop().await;
    drop(read_only);
}
