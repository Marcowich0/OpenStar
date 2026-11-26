//! Starting a Download (#195) against the fake USDB and the yt-dlp stub
//! first on `PATH`: nothing here reaches the network.
//!
//! Starting needs an Unlock (the video picker before it does not), is
//! refused on a read-only Library and for a USDB id already in the Library.
//! The job writes `song.txt`, `cover.jpg` (only when USDB has one),
//! `video.mp4` and `metadata.json` into a temporary folder, checks the text
//! with the Library's parser before yt-dlp runs, checks the USDB id again,
//! and moves the folder into the Library, where the Song is at once.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use openstar::clock::ManualClock;
use openstar::db::DATABASE_FILE;
use openstar::usdb::{UsdbTimer, VirtualTimer};
use openstar_protocol::admin::{ApiError, ApiErrorCode};
use openstar_protocol::jobs::{Job, JobId, JobKind, JobList, JobState};
use openstar_protocol::library::{SongIdentity, SongList};
use openstar_protocol::song::TxtRejection;
use openstar_protocol::usdb::{
    DownloadStarted, StartDownload, UsdbMirrorState, UsdbMirrorStatus, UsdbTextVersion,
};
use openstar_protocol::{PhoneId, UserMessage};
use openstar_test_harness::{
    AppFolders, FakeSong, FakeUsdb, Media, TestApp, TestAppBuilder, YtDlpStub, YtDlpStubBehaviour,
};
use reqwest::StatusCode;
use sha2::{Digest, Sha256};

/// USDB's `lastchange` of the fake's songs.
const LAST_CHANGE: i64 = 1_700_000_000;

/// A fake JPEG for song 1's cover.
const COVER: &[u8] = b"\xff\xd8\xff\xe0 fake cover \xff\xd9";

const VIDEO: &str = "https://www.youtube.com/watch?v=AAAAAAAAAAA";

/// The folder song 1 (`Placeholder Artist`, `Re: Stacks`) is written to.
const SONG_1_FOLDER: &str = "Placeholder Artist - Re_ Stacks";

fn builder(usdb: &FakeUsdb, stub: &YtDlpStub) -> TestAppBuilder {
    TestApp::builder()
        .usdb(usdb)
        .ytdlp_stub(stub)
        .clock(&ManualClock::new())
        .usdb_timer(Arc::new(VirtualTimer::new()) as Arc<dyn UsdbTimer>)
}

/// A fake USDB whose list holds songs 1 to 4; song 1 has a cover.
async fn fake_usdb() -> FakeUsdb {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(vec![
        FakeSong::new(1, "Placeholder Artist", "Re: Stacks", LAST_CHANGE),
        FakeSong::new(2, "Fake & Band", "Re: Stacks", LAST_CHANGE - 10),
        FakeSong::new(3, "Placeholder Artist", "No Tempo", LAST_CHANGE - 20),
        FakeSong::new(
            4,
            "Placeholder Artist",
            "Another Placeholder",
            LAST_CHANGE - 30,
        ),
    ]);
    usdb.set_cover(1, COVER.to_vec());
    usdb
}

async fn started(usdb: &FakeUsdb, stub: &YtDlpStub) -> TestApp {
    let app = builder(usdb, stub).start().await;
    wait_for_fresh_mirror(&app).await;
    app
}

async fn wait_for_fresh_mirror(app: &TestApp) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let status: UsdbMirrorStatus = app.get_json("/api/usdb/mirror").await;
        if status.state == UsdbMirrorState::Fresh {
            return;
        }
        assert!(tokio::time::Instant::now() < deadline, "mirror: {status:?}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn browser() -> PhoneId {
    PhoneId("browser-that-started-it".to_owned())
}

async fn start_download(app: &TestApp, cookie: Option<&str>, id: u32) -> reqwest::Response {
    let mut request = app
        .http()
        .post(app.url("/api/downloads"))
        .json(&StartDownload {
            usdb_id: id,
            video_url: VIDEO.to_owned(),
            browser: browser(),
        });
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    request.send().await.unwrap()
}

/// Starts a Download with an Unlock and returns its job.
async fn download(app: &TestApp, cookie: &str, id: u32) -> JobId {
    let response = start_download(app, Some(cookie), id).await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "starting a Download of {id}"
    );
    response.json::<DownloadStarted>().await.unwrap().job_id
}

async fn job(app: &TestApp, id: JobId) -> Job {
    let list: JobList = app.get_json("/api/jobs").await;
    list.jobs
        .into_iter()
        .find(|job| job.id == id)
        .expect("the job is listed")
}

/// Waits for the job to end and returns its end state.
async fn ended(app: &TestApp, id: JobId) -> JobState {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let job = job(app, id).await;
        assert_eq!(job.kind, JobKind::Download);
        if matches!(job.state, JobState::Done | JobState::Failed { .. }) {
            return job.state;
        }
        assert!(tokio::time::Instant::now() < deadline, "job: {job:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The folder names in the Library, sorted.
fn library_folders(app: &TestApp) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(app.songs_dir())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

/// The file names in a folder, sorted.
fn files_in(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

/// What is left in the Downloads' temporary folders.
fn staged(app: &TestApp) -> Vec<String> {
    let staging = app.appdata_dir().join("tmp/new-songs");
    if !staging.exists() {
        return Vec::new();
    }
    files_in(&staging)
}

fn expected_song_txt(name: &str) -> Vec<u8> {
    std::fs::read(FakeUsdb::default_fixtures().join("song-txt").join(name)).unwrap()
}

/// The arguments of every yt-dlp call that downloaded (not `--version`).
fn downloads_run(stub: &YtDlpStub) -> Vec<Vec<String>> {
    stub.calls()
        .into_iter()
        .filter(|call| !call.iter().any(|arg| arg == "--version"))
        .collect()
}

async fn refusal(response: reqwest::Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    (status, response.json().await.unwrap())
}

/// Puts a Song folder with `metadata.json` naming `usdb_id` into the
/// Library and rescans, so the id is in the Library.
async fn put_song_with_usdb_id(app: &TestApp, cookie: &str, folder: &str, usdb_id: u32) {
    let dir = app.songs_dir().join(folder);
    std::fs::create_dir_all(&dir).unwrap();
    // Real audio: a file the probe cannot read would leave the Song
    // unplayable, and so not in the Library.
    let media = Media::new();
    let audio = media.tone("song.m4a", 440.0, 1.0, 44_100).unwrap();
    std::fs::copy(audio, dir.join("song.m4a")).unwrap();
    std::fs::write(
        dir.join("song.txt"),
        "#ARTIST:Someone\n#TITLE:Already Here\n#MP3:song.m4a\n#BPM:200\n: 0 4 0 La\nE\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("metadata.json"),
        format!(r#"{{"apiId": {usdb_id}}}"#),
    )
    .unwrap();
    let response = app
        .http()
        .post(app.url("/api/library/rescan"))
        .header("cookie", cookie)
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "rescan: {}",
        response.status()
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let version: UsdbTextVersion = app
            .get_json(&format!("/api/usdb/songs/{usdb_id}/version"))
            .await;
        if version != UsdbTextVersion::NotInLibrary {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the rescan never found it"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn starting_a_download_needs_an_unlock_but_the_picker_does_not() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let app = started(&usdb, &stub).await;

    let picker = app
        .http()
        .get(app.url("/api/usdb/songs/1/videos"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        picker.status(),
        StatusCode::OK,
        "the picker needs no Unlock"
    );

    let refused = start_download(&app, None, 1).await;
    assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
    let error: ApiError = refused.json().await.unwrap();
    assert_eq!(error.code, ApiErrorCode::UnlockRequired);
    let list: JobList = app.get_json("/api/jobs").await;
    assert!(
        list.jobs.iter().all(|job| job.kind != JobKind::Download),
        "a refused Download stores no job"
    );

    let cookie = app.unlock().await;
    let id = download(&app, &cookie, 1).await;
    assert_eq!(ended(&app, id).await, JobState::Done);
}

#[tokio::test]
async fn a_download_writes_the_song_into_the_library_and_records_its_version() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;
    let mut ws = app.connect_ws().await;

    let id = download(&app, &cookie, 1).await;
    assert_eq!(ended(&app, id).await, JobState::Done);

    assert_eq!(library_folders(&app), vec![SONG_1_FOLDER.to_owned()]);
    let folder = app.songs_dir().join(SONG_1_FOLDER);
    assert_eq!(
        files_in(&folder),
        vec!["cover.jpg", "metadata.json", "song.txt", "video.mp4"]
    );
    let song_txt = std::fs::read(folder.join("song.txt")).unwrap();
    assert_eq!(song_txt, expected_song_txt("1-with-cover.txt"));
    assert_eq!(std::fs::read(folder.join("cover.jpg")).unwrap(), COVER);
    assert!(std::fs::metadata(folder.join("video.mp4")).unwrap().len() > 0);
    let metadata: serde_json::Value =
        serde_json::from_slice(&std::fs::read(folder.join("metadata.json")).unwrap()).unwrap();
    assert_eq!(metadata, serde_json::json!({ "apiId": 1, "video": VIDEO }));
    assert!(staged(&app).is_empty(), "the temporary folder is gone");

    // The Song is in the Library at once, by its USDB id, with no scan.
    let songs: SongList = app.get_json("/api/songs").await;
    let song = songs
        .songs
        .iter()
        .find(|song| song.path.starts_with(SONG_1_FOLDER))
        .expect("the new Song is listed");
    assert_eq!(song.identity, SongIdentity::Usdb { usdb_id: 1 });
    assert_eq!(song.title, "Re: Stacks");
    let scan: serde_json::Value = app.get_json("/api/library/scan").await;
    assert_eq!(scan["finished"], 1, "only the start-up scan ran");

    // `lastchange` and the SHA-256 of `song.txt` as written.
    let version: UsdbTextVersion = app.get_json("/api/usdb/songs/1/version").await;
    assert_eq!(
        version,
        UsdbTextVersion::Known {
            last_change: Some(LAST_CHANGE),
            txt_sha256: hex(&Sha256::digest(&song_txt)),
        }
    );

    // Every browser heard the Library change.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let openstar_protocol::ServerMessage::Changed { topics } = ws.recv().await
            && topics.contains(&openstar_protocol::ChangeTopic::Library)
        {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
async fn without_a_usdb_cover_there_is_no_cover_file_and_no_cover_header() {
    let usdb = fake_usdb().await;
    // Song 2's cover answers an empty body: no zero-byte `cover.jpg`.
    usdb.set_cover(2, Vec::new());
    let stub = YtDlpStub::new();
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;

    let id = download(&app, &cookie, 2).await;
    assert_eq!(ended(&app, id).await, JobState::Done);

    let folder = app.songs_dir().join("Fake & Band - Re_ Stacks");
    assert_eq!(
        files_in(&folder),
        vec!["metadata.json", "song.txt", "video.mp4"]
    );
    // A 1.x text: `#AUDIO` is set too, `#COVER` and `#BACKGROUND` removed.
    assert_eq!(
        std::fs::read(folder.join("song.txt")).unwrap(),
        expected_song_txt("2-without-cover.txt")
    );
}

#[tokio::test]
async fn yt_dlp_prefers_h264_mp4_up_to_1080p_and_always_writes_video_mp4() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;

    let id = download(&app, &cookie, 1).await;
    assert_eq!(ended(&app, id).await, JobState::Done);

    let calls = downloads_run(&stub);
    assert_eq!(calls.len(), 1, "{calls:?}");
    let call = &calls[0];
    let value_of = |flag: &str| {
        let at = call
            .iter()
            .position(|arg| arg == flag)
            .unwrap_or_else(|| panic!("{flag} in {call:?}"));
        call[at + 1].clone()
    };
    // A sort, not a filter: an AV1-only video is still taken.
    assert_eq!(value_of("-S"), "vcodec:h264,res:1080,ext:mp4:m4a");
    assert!(
        !call.iter().any(|arg| arg == "-f" || arg == "--format"),
        "{call:?}"
    );
    assert_eq!(value_of("-o"), "video.%(ext)s");
    assert_eq!(value_of("--merge-output-format"), "mp4");
    assert_eq!(value_of("--remux-video"), "mp4");
    assert!(call.iter().any(|arg| arg == "--no-playlist"));
    assert_eq!(call.last().unwrap(), VIDEO);
    assert_eq!(
        call[call.len() - 2],
        "--",
        "the link is never read as an option"
    );
}

#[tokio::test]
async fn a_text_the_parser_rejects_fails_before_yt_dlp_runs() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;

    let id = download(&app, &cookie, 3).await;
    assert_eq!(
        ended(&app, id).await,
        JobState::Failed {
            reason: UserMessage::UsdbTextRejected {
                rejection: TxtRejection::MissingBpm,
            },
        }
    );
    assert!(downloads_run(&stub).is_empty(), "yt-dlp never ran");
    assert!(staged(&app).is_empty(), "the temporary folder is removed");
    assert!(library_folders(&app).is_empty());
}

#[tokio::test]
async fn a_usdb_id_already_in_the_library_is_refused_when_the_download_starts() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;
    put_song_with_usdb_id(&app, &cookie, "Mine", 1).await;
    assert_eq!(
        app.get_json::<UsdbTextVersion>("/api/usdb/songs/1/version")
            .await,
        UsdbTextVersion::Unknown,
        "a Library Song with a USDB id that OpenStar did not download"
    );

    let (status, body) = refusal(start_download(&app, Some(&cookie), 1).await).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        serde_json::from_value::<UserMessage>(body).unwrap(),
        UserMessage::UsdbSongInLibrary
    );
    let list: JobList = app.get_json("/api/jobs").await;
    assert!(list.jobs.iter().all(|job| job.kind != JobKind::Download));
    assert_eq!(library_folders(&app), vec!["Mine".to_owned()]);
}

#[tokio::test]
async fn a_usdb_id_that_reaches_the_library_meanwhile_is_refused_before_the_move() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    stub.script(YtDlpStubBehaviour::Delay(Duration::from_secs(2)), 1);
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;

    let id = download(&app, &cookie, 1).await;
    put_song_with_usdb_id(&app, &cookie, "Mine", 1).await;
    assert!(
        matches!(job(&app, id).await.state, JobState::Running { .. }),
        "the Download was still fetching the video"
    );

    assert_eq!(
        ended(&app, id).await,
        JobState::Failed {
            reason: UserMessage::UsdbSongInLibrary,
        }
    );
    assert_eq!(library_folders(&app), vec!["Mine".to_owned()]);
    assert!(staged(&app).is_empty(), "the temporary folder is removed");
}

#[tokio::test]
async fn a_taken_folder_name_gets_a_number_and_the_old_folder_is_untouched() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;
    let taken = app.songs_dir().join(SONG_1_FOLDER);
    std::fs::create_dir(&taken).unwrap();
    std::fs::write(taken.join("notes.md"), b"mine").unwrap();

    let id = download(&app, &cookie, 1).await;
    assert_eq!(ended(&app, id).await, JobState::Done);

    assert_eq!(
        library_folders(&app),
        vec![SONG_1_FOLDER.to_owned(), format!("{SONG_1_FOLDER} (2)")]
    );
    assert_eq!(files_in(&taken), vec!["notes.md"]);
    assert_eq!(std::fs::read(taken.join("notes.md")).unwrap(), b"mine");
    assert!(
        app.songs_dir()
            .join(format!("{SONG_1_FOLDER} (2)"))
            .join("song.txt")
            .exists()
    );
}

#[tokio::test]
async fn a_read_only_library_refuses_a_download_even_with_an_unlock() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let folders = AppFolders::new();
    // A missing songs folder makes the Library read-only, also as root.
    std::fs::remove_dir(folders.songs_dir()).unwrap();
    let app = builder(&usdb, &stub).folders(folders).start().await;
    let cookie = app.unlock().await;

    let refused = start_download(&app, Some(&cookie), 1).await;
    assert_eq!(refused.status(), StatusCode::CONFLICT);
    let error: ApiError = refused.json().await.unwrap();
    assert_eq!(error.code, ApiErrorCode::LibraryReadOnly);
    assert!(downloads_run(&stub).is_empty());
}

#[tokio::test]
async fn a_link_that_is_not_http_is_refused() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;
    let response = app
        .http()
        .post(app.url("/api/downloads"))
        .header("cookie", &cookie)
        .json(&StartDownload {
            usdb_id: 1,
            video_url: "--exec=rm -rf /".to_owned(),
            browser: browser(),
        })
        .send()
        .await
        .unwrap();
    let (status, body) = refusal(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_value::<UserMessage>(body).unwrap(),
        UserMessage::InvalidMessage
    );
}

#[tokio::test]
async fn the_download_job_is_stored_and_at_most_two_run_at_once() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    stub.script(YtDlpStubBehaviour::Delay(Duration::from_millis(800)), 3);
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;

    // Three Downloads: the first two run, the third waits for a slot in
    // the Download lane.
    let ids = [
        download(&app, &cookie, 1).await,
        download(&app, &cookie, 2).await,
        download(&app, &cookie, 4).await,
    ];
    assert_eq!(job(&app, ids[2]).await.state, JobState::Queued);
    for id in ids {
        assert_eq!(ended(&app, id).await, JobState::Done);
    }
    let spans: Vec<(f64, f64)> = stub.call_spans().into_iter().flatten().collect();
    assert_eq!(spans.len(), 3, "{spans:?}");
    for (start, _) in &spans {
        let at_once = spans
            .iter()
            .filter(|(s, e)| s <= start && start < e)
            .count();
        assert!(at_once <= 2, "{spans:?}");
    }
    let folders = app.stop().await;
    let db = rusqlite::Connection::open(folders.appdata_dir().join(DATABASE_FILE)).unwrap();
    let (params, state, percent): (String, String, Option<i64>) = db
        .query_row(
            "SELECT params, state, percent FROM jobs WHERE id = ?1",
            [ids[0].0],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    let params: serde_json::Value = serde_json::from_str(&params).unwrap();
    assert_eq!(params["kind"], "download");
    assert_eq!(params["usdbId"], 1);
    assert_eq!(params["videoUrl"], VIDEO);
    assert_eq!(params["browser"], "browser-that-started-it");
    assert_eq!(state, "done");
    assert_eq!(percent, Some(100));
}
