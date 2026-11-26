//! Starting a Download (#195) against the fake USDB and the yt-dlp stub
//! first on `PATH`: nothing here reaches the network.
//!
//! Starting needs an Unlock (the video picker before it does not), is
//! refused on a read-only Library and for a USDB id already in the Library.
//! The job writes `song.txt`, `cover.jpg` (only when USDB has one),
//! `video.mp4` and `metadata.json` into a temporary folder, checks the text
//! with the Library's parser before yt-dlp runs, checks the USDB id again,
//! and moves the folder into the Library, where the Song is at once.
//!
//! The Downloads list (#196): every Download over `GET /api/jobs` and live
//! over the WebSocket with its song, percent, speed and ETA; cancelling
//! without a PIN; each step retried twice with a 1.5 s backoff that doubles;
//! the 403 fallback; a failure or cancel removing only the temporary
//! folder; a restart starting an interrupted Download again from scratch.
//!
//! "Add to Queue" (#197): a finished Download names its new Song once the
//! Song is in the Library index, and the Phone that started it queues it.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use openstar::clock::ManualClock;
use openstar::db::DATABASE_FILE;
use openstar::usdb::{UsdbTimer, VirtualTimer};
use openstar_protocol::admin::{ApiError, ApiErrorCode};
use openstar_protocol::jobs::{DownloadRate, Job, JobId, JobKind, JobList, JobState};
use openstar_protocol::library::{SongIdentity, SongList};
use openstar_protocol::profile::{Avatar, AvatarKey, PaletteKey};
use openstar_protocol::song::TxtRejection;
use openstar_protocol::usdb::{
    DownloadStarted, StartDownload, UsdbMirrorState, UsdbMirrorStatus, UsdbTextVersion,
};
use openstar_protocol::{
    ClientMessage, JoinAs, NewGuest, PartySnapshot, PhoneId, ServerMessage, UserMessage,
};
use openstar_test_harness::{
    AppFolders, FakeSong, FakeUsdb, Media, TestApp, TestAppBuilder, WsClient, YtDlpStub,
    YtDlpStubBehaviour,
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
    builder_with_timer(usdb, stub, Arc::new(VirtualTimer::new()))
}

/// [`builder`] with a timer the test keeps, to read the waits.
fn builder_with_timer(
    usdb: &FakeUsdb,
    stub: &YtDlpStub,
    timer: Arc<VirtualTimer>,
) -> TestAppBuilder {
    TestApp::builder()
        .usdb(usdb)
        .ytdlp_stub(stub)
        .clock(&ManualClock::new())
        .usdb_timer(timer as Arc<dyn UsdbTimer>)
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
    assert!(call.iter().any(|arg| arg == "--newline"));
    assert_eq!(
        value_of("--progress-template"),
        "download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s"
    );
    assert!(
        !call.iter().any(|arg| arg == "--extractor-args"),
        "no fallback before YouTube refused: {call:?}"
    );
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

/// Every update of job `id` on `socket` until it ends, in order.
async fn follow_job(socket: &mut WsClient, id: JobId) -> Vec<Job> {
    let mut seen = Vec::new();
    loop {
        if let ServerMessage::JobChanged { job } = socket.recv().await
            && job.id == id
        {
            let ended = matches!(job.state, JobState::Done | JobState::Failed { .. });
            seen.push(job);
            if ended {
                return seen;
            }
        }
    }
}

#[tokio::test]
async fn every_browser_sees_each_download_with_its_song_and_live_progress() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;
    // A Remote (a Phone that said hello) and an Admin area's page.
    let mut remote = app.connect_ws().await;
    remote
        .send(&ClientMessage::Hello {
            phone_id: PhoneId("a-remote".to_owned()),
        })
        .await;
    let mut admin = app.connect_ws().await;

    let id = download(&app, &cookie, 1).await;
    for socket in [&mut remote, &mut admin] {
        let seen = follow_job(socket, id).await;
        let running: Vec<&Job> = seen
            .iter()
            .filter(|job| matches!(job.state, JobState::Running { .. }))
            .collect();
        assert!(!running.is_empty(), "{seen:?}");
        // yt-dlp's 50% line: halfway between the text (10) and the end of
        // the video (90), at 1 MiB/s with a second to go.
        let halfway = running
            .iter()
            .find(|job| job.state == JobState::Running { percent: Some(50) })
            .unwrap_or_else(|| panic!("50% in {seen:?}"));
        let details = halfway.download.as_ref().expect("a Download's details");
        assert_eq!(details.usdb_id, 1);
        assert_eq!(details.artist.as_deref(), Some("Placeholder Artist"));
        assert_eq!(details.title.as_deref(), Some("Re: Stacks"));
        assert_eq!(details.video_url, VIDEO);
        assert_eq!(details.browser, browser());
        assert_eq!(
            details.rate,
            Some(DownloadRate {
                bytes_per_second: Some(1024 * 1024),
                eta_seconds: Some(1),
            })
        );
        let percents: Vec<u8> = running
            .iter()
            .filter_map(|job| match job.state {
                JobState::Running { percent } => percent,
                _ => None,
            })
            .collect();
        assert!(percents.is_sorted(), "never backwards: {percents:?}");
        let last = seen.last().unwrap();
        assert_eq!(last.state, JobState::Done);
        assert_eq!(last.download.as_ref().unwrap().rate, None);
    }

    let listed = job(&app, id).await;
    assert_eq!(listed.state, JobState::Done);
    assert_eq!(
        listed.download.unwrap().title.as_deref(),
        Some("Re: Stacks")
    );
}

/// Waits until yt-dlp call `call` (from 1, `--version` checks counted) has
/// started, and returns its process id.
async fn ytdlp_running(stub: &YtDlpStub, call: usize) -> u32 {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(Some(pid)) = stub.call_pids().get(call - 1) {
            return *pid;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "yt-dlp call {call}: {:?}",
            stub.calls()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The number of the yt-dlp call that downloads next (`--version` checks
/// counted), once `downloads` downloads have run before it.
async fn next_download_call(stub: &YtDlpStub, downloads: usize) -> usize {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let calls = stub.calls();
        let at = calls
            .iter()
            .enumerate()
            .filter(|(_, call)| !call.iter().any(|arg| arg == "--version"))
            .nth(downloads)
            .map(|(at, _)| at + 1);
        if let Some(at) = at {
            return at;
        }
        assert!(tokio::time::Instant::now() < deadline, "{calls:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn cancel(app: &TestApp, id: JobId) -> StatusCode {
    app.http()
        .post(app.url(&format!("/api/downloads/{}/cancel", id.0)))
        .send()
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn cancelling_needs_no_pin_stops_yt_dlp_and_removes_only_the_temporary_folder() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    stub.script(YtDlpStubBehaviour::Hang, 2);
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;
    let mine = app.songs_dir().join("Mine");
    std::fs::create_dir(&mine).unwrap();
    std::fs::write(mine.join("notes.md"), b"mine").unwrap();

    // Two run (and hang in yt-dlp); the third waits for a slot.
    let first = download(&app, &cookie, 1).await;
    let second = download(&app, &cookie, 2).await;
    let waiting = download(&app, &cookie, 4).await;
    let mut pids = Vec::new();
    for downloads in 0..2 {
        let call = next_download_call(&stub, downloads).await;
        pids.push(ytdlp_running(&stub, call).await);
    }
    assert_eq!(job(&app, waiting).await.state, JobState::Queued);
    assert_eq!(staged(&app).len(), 2, "both running ones have a folder");

    // A waiting Download is cancelled before it ever runs: no cookie.
    assert_eq!(cancel(&app, waiting).await, StatusCode::NO_CONTENT);
    assert_eq!(
        ended(&app, waiting).await,
        JobState::Failed {
            reason: UserMessage::JobCancelled,
        }
    );

    assert_eq!(cancel(&app, first).await, StatusCode::NO_CONTENT);
    assert_eq!(cancel(&app, second).await, StatusCode::NO_CONTENT);
    for id in [first, second] {
        assert_eq!(
            ended(&app, id).await,
            JobState::Failed {
                reason: UserMessage::JobCancelled,
            }
        );
    }
    for pid in pids {
        assert!(
            !Path::new(&format!("/proc/{pid}")).exists(),
            "the yt-dlp process {pid} is stopped"
        );
    }
    assert_eq!(downloads_run(&stub).len(), 2, "the waiting one never ran");
    assert!(staged(&app).is_empty(), "the temporary folders are removed");
    assert_eq!(library_folders(&app), vec!["Mine".to_owned()]);
    assert_eq!(std::fs::read(mine.join("notes.md")).unwrap(), b"mine");

    // An ended Download, or another kind of job, cannot be cancelled here.
    assert_eq!(cancel(&app, first).await, StatusCode::NOT_FOUND);
    assert_eq!(cancel(&app, JobId(9_999)).await, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_failing_video_is_tried_twice_more_with_a_doubling_wait_then_leaves_the_library_untouched()
 {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    stub.script(
        YtDlpStubBehaviour::Fail {
            exit_code: 1,
            message: "ERROR: [generic] Unable to download webpage".to_owned(),
        },
        3,
    );
    let timer = Arc::new(VirtualTimer::new());
    let app = builder_with_timer(&usdb, &stub, timer.clone())
        .start()
        .await;
    wait_for_fresh_mirror(&app).await;
    let cookie = app.unlock().await;
    // A Library folder with the very name the Download would take.
    let taken = app.songs_dir().join(SONG_1_FOLDER);
    std::fs::create_dir(&taken).unwrap();
    std::fs::write(taken.join("notes.md"), b"mine").unwrap();

    let id = download(&app, &cookie, 1).await;
    assert_eq!(
        ended(&app, id).await,
        JobState::Failed {
            reason: UserMessage::VideoDownloadFailed,
        }
    );
    assert_eq!(downloads_run(&stub).len(), 3, "the first try and 2 retries");
    // USDB's pacing waits are at most a second; the retries' are longer.
    let retry_waits: Vec<Duration> = timer
        .waits()
        .into_iter()
        .filter(|wait| *wait > Duration::from_secs(1))
        .collect();
    assert_eq!(
        retry_waits,
        vec![Duration::from_millis(1500), Duration::from_millis(3000)]
    );
    assert!(staged(&app).is_empty(), "the temporary folder is removed");
    assert_eq!(library_folders(&app), vec![SONG_1_FOLDER.to_owned()]);
    assert_eq!(files_in(&taken), vec!["notes.md"]);
    assert_eq!(std::fs::read(taken.join("notes.md")).unwrap(), b"mine");
}

#[tokio::test]
async fn after_a_403_later_attempts_ask_as_other_youtube_clients() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    stub.script(
        YtDlpStubBehaviour::Fail {
            exit_code: 1,
            message: "ERROR: [youtube] AAAAAAAAAAA: Unable to download video data: HTTP Error 403: Forbidden".to_owned(),
        },
        1,
    );
    stub.script(
        YtDlpStubBehaviour::Fail {
            exit_code: 1,
            message: "ERROR: [youtube] AAAAAAAAAAA: Read timed out".to_owned(),
        },
        1,
    );
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;

    let id = download(&app, &cookie, 1).await;
    assert_eq!(ended(&app, id).await, JobState::Done);
    let calls = downloads_run(&stub);
    assert_eq!(calls.len(), 3, "{calls:?}");
    let fallback = |call: &Vec<String>| {
        call.windows(2)
            .position(|pair| {
                pair[0] == "--extractor-args" && pair[1] == "youtube:player_client=tv,web_embedded"
            })
            .is_some_and(|at| at < call.iter().position(|arg| arg == "--").unwrap())
    };
    assert!(!fallback(&calls[0]), "{:?}", calls[0]);
    assert!(fallback(&calls[1]), "{:?}", calls[1]);
    assert!(fallback(&calls[2]), "it stays: {:?}", calls[2]);
    assert_eq!(
        library_folders(&app),
        vec![SONG_1_FOLDER.to_owned()],
        "the retried Download is in the Library"
    );
}

#[tokio::test]
async fn a_restart_in_the_middle_removes_the_temporary_folder_and_starts_again_from_scratch() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    stub.script(YtDlpStubBehaviour::Hang, 1);
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;

    let id = download(&app, &cookie, 1).await;
    let call = next_download_call(&stub, 0).await;
    let pid = ytdlp_running(&stub, call).await;
    let folders = app.stop().await;
    assert!(
        !Path::new(&format!("/proc/{pid}")).exists(),
        "stopping stops yt-dlp"
    );
    // What a hard stop would leave: a half-written temporary folder.
    let leftover = folders.appdata_dir().join("tmp/new-songs/leftover");
    std::fs::create_dir_all(&leftover).unwrap();
    std::fs::write(leftover.join("video.f137.mp4.part"), b"half").unwrap();
    std::fs::write(leftover.join("song.txt"), b"#TITLE:half").unwrap();

    let app = builder(&usdb, &stub).folders(folders).start().await;
    assert_eq!(ended(&app, id).await, JobState::Done);
    assert!(!leftover.exists(), "the leftover folder is removed");
    assert!(staged(&app).is_empty());
    let runs = downloads_run(&stub);
    assert_eq!(runs.len(), 2, "yt-dlp ran again: {runs:?}");
    assert_eq!(library_folders(&app), vec![SONG_1_FOLDER.to_owned()]);
    assert_eq!(
        files_in(&app.songs_dir().join(SONG_1_FOLDER)),
        vec!["cover.jpg", "metadata.json", "song.txt", "video.mp4"]
    );
}

/// The next message on `socket` past change notices for HTTP data and job
/// updates.
async fn next_live(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. } | ServerMessage::JobChanged { .. } => {}
            message => return message,
        }
    }
}

async fn queue_changed(socket: &mut WsClient) -> PartySnapshot {
    loop {
        if let ServerMessage::PartyChanged { party, .. } = next_live(socket).await {
            return party;
        }
    }
}

/// "Add to Queue" (#197): a finished Download names its new Song once the
/// Song is in the Library index, and the browser that started it, a Phone in
/// the Party, queues it like any Library Song; every Remote hears it.
#[tokio::test]
async fn a_finished_download_names_its_new_song_which_the_phone_that_started_it_can_queue() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;
    let mut stage = app.connect_stage().await;
    let join_code = loop {
        if let ServerMessage::PartyChanged { party, .. } = next_live(&mut stage).await {
            break party.join_code;
        }
    };
    let mut phone = app.connect_ws().await;
    phone
        .send(&ClientMessage::Join {
            phone_id: browser(),
            join_code,
            join_as: JoinAs::Guest(NewGuest {
                name: "Bo".to_owned(),
                colour: PaletteKey::Sky,
                avatar: Avatar::BuiltIn {
                    key: AvatarKey::Star,
                },
            }),
        })
        .await;
    let member = loop {
        if let ServerMessage::PhoneStatus {
            member_id: Some(member),
        } = next_live(&mut phone).await
        {
            break member;
        }
    };
    queue_changed(&mut stage).await;
    let mut remote = app.connect_ws().await;

    let id = download(&app, &cookie, 1).await;
    let seen = follow_job(&mut remote, id).await;
    for job in &seen[..seen.len() - 1] {
        assert_eq!(job.download.as_ref().unwrap().song, None, "{job:?}");
    }
    let done = seen.last().unwrap();
    assert_eq!(done.state, JobState::Done);
    let songs: SongList = app.get_json("/api/songs").await;
    let new_song = songs
        .songs
        .iter()
        .find(|song| song.identity == SongIdentity::Usdb { usdb_id: 1 })
        .expect("the new Song is in the Library")
        .id;
    assert_eq!(done.download.as_ref().unwrap().song, Some(new_song));
    assert_eq!(
        job(&app, id).await.download.unwrap().song,
        Some(new_song),
        "the list says it too"
    );

    phone
        .send(&ClientMessage::AddRequest {
            song_id: new_song,
            requested_players: None,
        })
        .await;
    for socket in [&mut phone, &mut stage, &mut remote] {
        let party = loop {
            match next_live(socket).await {
                ServerMessage::PartyChanged { party, .. } if !party.queue.is_empty() => {
                    break party;
                }
                ServerMessage::Rejected { reason } => panic!("refused: {reason:?}"),
                _ => {}
            }
        };
        assert_eq!(party.queue.len(), 1);
        assert_eq!(party.queue[0].song_id, new_song);
        assert_eq!(party.queue[0].adder, Some(member));
    }
}

/// A failed or cancelled Download names no Song, and a finished one still
/// names its Song after a restart.
#[tokio::test]
async fn only_a_finished_download_names_a_song_also_after_a_restart() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    stub.script(YtDlpStubBehaviour::Hang, 1);
    let mut app = started(&usdb, &stub).await;
    let cookie = app.unlock().await;

    let rejected = download(&app, &cookie, 3).await;
    assert!(matches!(
        ended(&app, rejected).await,
        JobState::Failed { .. }
    ));
    let cancelled = download(&app, &cookie, 1).await;
    let call = next_download_call(&stub, 0).await;
    ytdlp_running(&stub, call).await;
    assert_eq!(cancel(&app, cancelled).await, StatusCode::NO_CONTENT);
    assert!(matches!(
        ended(&app, cancelled).await,
        JobState::Failed { .. }
    ));
    let finished = download(&app, &cookie, 4).await;
    assert_eq!(ended(&app, finished).await, JobState::Done);

    assert_eq!(job(&app, rejected).await.download.unwrap().song, None);
    assert_eq!(job(&app, cancelled).await.download.unwrap().song, None);
    let song = job(&app, finished).await.download.unwrap().song;
    assert!(song.is_some());
    app.restart().await;
    assert_eq!(job(&app, finished).await.download.unwrap().song, song);
    assert_eq!(job(&app, rejected).await.download.unwrap().song, None);
}
