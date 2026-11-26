//! New Song folders written into the Library (#77), through the real app
//! over HTTP and the WebSocket. Downloads (#47) are the real caller; until
//! then the operation is reached through the test-only route
//! `POST /api/test/library/new-song`, which stages the files it is given
//! (copied from paths on this machine) and publishes them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use openstar_protocol::admin::UnlockRequest;
use openstar_protocol::library::{ScanStatus, SongDetail, SongList};
use openstar_protocol::{ChangeTopic, ServerMessage};
use openstar_test_harness::TestApp;
use reqwest::StatusCode;
use serde_json::{Value, json};

const TXT: &str = "#ARTIST:Placeholder\n#TITLE:New\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n";

/// Every file below `dir`, relative, with its content.
fn snapshot(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut folders = vec![PathBuf::new()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(dir.join(&folder)).unwrap() {
            let entry = entry.unwrap();
            let relative = folder.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                files.insert(relative.join(""), Vec::new());
                folders.push(relative);
            } else {
                files.insert(relative, std::fs::read(entry.path()).unwrap());
            }
        }
    }
    files
}

/// An app with the test routes whose Library holds a folder already named
/// `Placeholder - New` (its Song has another title).
async fn app() -> TestApp {
    let mut app = TestApp::builder().test_routes().start().await;
    let taken = app.songs_dir().join("Placeholder - New");
    std::fs::create_dir(&taken).unwrap();
    openstar_test_harness::placeholder_media(&taken.join("song.mp3")).unwrap();
    std::fs::write(taken.join("song.txt"), TXT.replace("New", "Old")).unwrap();
    app.restart().await;
    app
}

async fn unlock(app: &TestApp) -> String {
    let response = app
        .http()
        .post(app.url("/api/unlock"))
        .json(&UnlockRequest {
            pin: "1234".to_owned(),
        })
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"].to_str().unwrap();
    cookie.split(';').next().unwrap().trim().to_owned()
}

/// Source files for a new Song: its `.txt` and audio.
fn sources(dir: &Path) -> (PathBuf, PathBuf) {
    let txt = dir.join("song.txt");
    std::fs::write(&txt, TXT).unwrap();
    let audio = dir.join("song.mp3");
    openstar_test_harness::placeholder_media(&audio).unwrap();
    (txt, audio)
}

async fn new_song(app: &TestApp, files: Value) -> (StatusCode, Value) {
    let cookie = unlock(app).await;
    let response = app
        .http()
        .post(app.url("/api/test/library/new-song"))
        .header("cookie", cookie)
        .json(&json!({ "artist": "Placeholder", "title": "New", "files": files }))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// What is left in `/appdata`'s temporary folder for new Songs.
fn staged(app: &TestApp) -> usize {
    match std::fs::read_dir(app.appdata_dir().join("tmp/new-songs")) {
        Ok(entries) => entries.count(),
        Err(_) => 0,
    }
}

#[tokio::test]
async fn a_new_song_gets_a_free_folder_name_and_is_listed_at_once() {
    let app = app().await;
    let before = snapshot(app.songs_dir());
    let mut socket = app.connect_ws().await;
    let dir = tempfile::tempdir().unwrap();
    let (txt, audio) = sources(dir.path());

    let (status, body) = new_song(
        &app,
        json!([{ "name": "song.mp3", "from": audio }, { "name": "song.txt", "from": txt }]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["folder"], "Placeholder - New (2)");

    // The taken folder is as it was; the new one holds exactly the files.
    let after = snapshot(app.songs_dir());
    for (path, content) in &before {
        assert_eq!(after.get(path), Some(content), "{}", path.display());
    }
    let new = snapshot(&app.songs_dir().join("Placeholder - New (2)"));
    let names: Vec<_> = new
        .keys()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["song.mp3", "song.txt"]);
    assert_eq!(new[Path::new("song.txt")], TXT.as_bytes());
    assert_eq!(staged(&app), 0);

    // Applied straight to the index, with a notice, and no scan ran.
    loop {
        if let ServerMessage::Changed { topics } = socket.recv().await
            && topics.contains(&ChangeTopic::Library)
        {
            break;
        }
    }
    let id = body["songs"][0].as_u64().unwrap();
    let song: SongDetail = app.get_json(&format!("/api/songs/{id}")).await;
    assert_eq!(song.path, "Placeholder - New (2)/song.txt");
    assert_eq!(song.song.headers.title, "New");
    let list: SongList = app.get_json("/api/songs").await;
    assert_eq!(list.songs.len(), 2);
    let scan: ScanStatus = app.get_json("/api/library/scan").await;
    assert_eq!(scan.finished, 1, "only the start-up scan ran");
}

#[tokio::test]
async fn a_failure_midway_leaves_the_library_untouched() {
    let app = app().await;
    let before = snapshot(app.songs_dir());
    let dir = tempfile::tempdir().unwrap();
    let (txt, audio) = sources(dir.path());

    // The second file cannot be read: the staging stops half-way.
    let (status, _) = new_song(
        &app,
        json!([
            { "name": "song.mp3", "from": audio },
            { "name": "video.mp4", "from": dir.path().join("not there.mp4") },
            { "name": "song.txt", "from": txt },
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(snapshot(app.songs_dir()), before);
    assert_eq!(staged(&app), 0, "the temporary folder is removed");
    let list: SongList = app.get_json("/api/songs").await;
    assert_eq!(list.songs.len(), 1);
}

#[tokio::test]
async fn a_temporary_folder_left_by_a_stop_is_removed_at_the_next_start() {
    let mut app = TestApp::start().await;
    let left = app.appdata_dir().join("tmp/new-songs/7");
    std::fs::create_dir_all(&left).unwrap();
    std::fs::write(left.join("song.txt"), TXT).unwrap();
    app.restart().await;
    assert_eq!(staged(&app), 0);
}
