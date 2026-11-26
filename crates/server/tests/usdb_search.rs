//! Searching USDB (#193) against the fake USDB: the search runs on the
//! mirror alone, sorts by rating or views, marks songs already in the
//! Library, and answers from what is mirrored so far while the mirror fills.
//! Covers come from USDB the first time they are asked for and from the
//! cache in `/appdata/cache` after that. Nothing here needs the Admin PIN.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use openstar::clock::ManualClock;
use openstar::usdb::{UsdbTimer, VirtualTimer};
use openstar_protocol::usdb::{
    USDB_SEARCH_LIMIT, UsdbMirrorState, UsdbMirrorStatus, UsdbSearchQuery, UsdbSearchResults,
    UsdbSort,
};
use openstar_protocol::jobs::JobState;
use openstar_protocol::{ChangeTopic, ServerMessage, UserMessage};
use openstar_test_harness::{AppFolders, FakeSong, FakeUsdb, Scripted, TestApp};

async fn app_with(usdb: &FakeUsdb, folders: AppFolders) -> TestApp {
    TestApp::builder()
        .usdb(usdb)
        .clock(&ManualClock::new())
        .usdb_timer(Arc::new(VirtualTimer::new()) as Arc<dyn UsdbTimer>)
        .folders(folders)
        .start()
        .await
}

async fn app_on(usdb: &FakeUsdb) -> TestApp {
    app_with(usdb, AppFolders::new()).await
}

async fn wait_for_mirror(
    app: &TestApp,
    what: &str,
    done: impl Fn(&UsdbMirrorStatus) -> bool,
) -> UsdbMirrorStatus {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let status: UsdbMirrorStatus = app.get_json("/api/usdb/mirror").await;
        if done(&status) {
            return status;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the mirror never became {what}: {status:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn filled(usdb: &FakeUsdb) -> TestApp {
    let app = app_on(usdb).await;
    wait_for_mirror(&app, "fresh", |s| s.state == UsdbMirrorState::Fresh).await;
    app
}

async fn search(app: &TestApp, query: &UsdbSearchQuery) -> UsdbSearchResults {
    let response = app
        .http()
        .get(app.url("/api/usdb/songs"))
        .query(query)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "searching {query:?}");
    response.json().await.unwrap()
}

fn words(search: &str) -> UsdbSearchQuery {
    UsdbSearchQuery {
        search: Some(search.to_owned()),
        sort: None,
    }
}

fn ids(results: &UsdbSearchResults) -> Vec<u32> {
    results.songs.iter().map(|song| song.usdb_id).collect()
}

fn song(id: u32, artist: &str, title: &str, half_stars: u8, views: u32) -> FakeSong {
    FakeSong {
        half_stars,
        views,
        ..FakeSong::new(id, artist, title, 1_700_000_000 - i64::from(id))
    }
}

fn some_songs() -> Vec<FakeSong> {
    vec![
        song(1, "Placeholder Band", "Straße Song", 8, 300),
        song(2, "Other Artist", "Placeholder Tune", 10, 100),
        song(3, "Someone", "Nothing Alike", 4, 900),
        song(4, "STRASSE Crew", "Another One", 6, 200),
    ]
}

/// Writes a playable Song with a `metadata.json` naming USDB id `usdb_id`.
fn write_downloaded_song(folder: &Path, usdb_id: u32) {
    std::fs::create_dir_all(folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        "#ARTIST:Placeholder Band\n#TITLE:Straße Song\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n",
    )
    .unwrap();
    std::fs::write(
        folder.join("metadata.json"),
        format!(r#"{{"apiId": {usdb_id}}}"#),
    )
    .unwrap();
}

#[tokio::test]
async fn a_search_matches_artist_or_title_and_asks_usdb_nothing() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(some_songs());
    let app = filled(&usdb).await;
    let before = usdb.requests().len();

    // Every word in the artist or the title, folded like the Library's
    // search: "strasse" finds "Straße".
    let found = search(&app, &words("strasse")).await;
    assert_eq!(ids(&found), [1, 4], "most views first by default");
    assert_eq!(found.total, 2);
    let found = search(&app, &words("placeholder tune")).await;
    assert_eq!(ids(&found), [2]);
    let found = search(&app, &words("  ")).await;
    assert_eq!(found.total, 4, "no words: every mirrored song");
    let found = search(&app, &words("nobody has this")).await;
    assert_eq!(found.total, 0);

    assert_eq!(usdb.requests().len(), before, "a search sends USDB nothing");
    let song = &search(&app, &words("tune")).await.songs[0];
    assert_eq!(song.artist, "Other Artist");
    assert_eq!(song.title, "Placeholder Tune");
    assert!((song.rating - 5.0).abs() < f32::EPSILON);
    assert_eq!(song.views, 100);
    assert_eq!(song.cover, "/api/usdb/songs/2/cover");
}

#[tokio::test]
async fn results_sort_by_rating_or_by_views() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(some_songs());
    let app = filled(&usdb).await;

    let by = |sort| UsdbSearchQuery {
        search: None,
        sort: Some(sort),
    };
    assert_eq!(ids(&search(&app, &by(UsdbSort::Views)).await), [3, 1, 4, 2]);
    assert_eq!(ids(&search(&app, &by(UsdbSort::Rating)).await), [2, 1, 4, 3]);
}

#[tokio::test]
async fn a_search_answers_at_most_the_limit_and_says_how_many_matched() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(FakeSong::many(1, 120, 1_700_000_000));
    let app = filled(&usdb).await;

    let found = search(&app, &words("placeholder")).await;
    assert_eq!(found.total, 120);
    assert_eq!(found.songs.len(), USDB_SEARCH_LIMIT as usize);
}

#[tokio::test]
async fn a_song_whose_usdb_id_is_in_the_library_is_marked_in_library() {
    let folders = AppFolders::new();
    write_downloaded_song(&folders.songs_dir().join("Placeholder Band - Straße Song"), 1);
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(some_songs());
    let app = app_with(&usdb, folders).await;
    wait_for_mirror(&app, "fresh", |s| s.state == UsdbMirrorState::Fresh).await;

    let found = search(&app, &UsdbSearchQuery::default()).await;
    let in_library: Vec<u32> = found
        .songs
        .iter()
        .filter(|song| song.in_library)
        .map(|song| song.usdb_id)
        .collect();
    assert_eq!(in_library, [1]);
}

#[tokio::test]
async fn while_the_mirror_fills_search_works_on_what_is_mirrored_so_far() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(FakeSong::many(1, 250, 1_700_000_000));
    // Login, profile and the first page; then USDB fails until the client
    // gives up, so the first fill stops after one page.
    usdb.script(Scripted::Page, 3);
    usdb.script(
        Scripted::Error {
            status: 503,
            retry_after: None,
        },
        5,
    );
    let app = app_on(&usdb).await;
    wait_for_mirror(&app, "incomplete", |s| {
        s.state == UsdbMirrorState::Incomplete
    })
    .await;

    let found = search(&app, &words("placeholder")).await;
    assert_eq!(found.total, 100);
    // The first page holds songs 1 to 100 (newest change first).
    assert_eq!(ids(&search(&app, &words("song 77")).await), [77]);
    assert_eq!(search(&app, &words("song 177")).await.total, 0);
}

/// The cover requests the fake has seen for `id`.
fn cover_requests(usdb: &FakeUsdb, id: u32) -> usize {
    let path = format!("/data/cover/{id}.jpg");
    usdb.requests().iter().filter(|r| r.path == path).count()
}

#[tokio::test]
async fn a_cover_is_fetched_once_when_first_shown_and_then_served_from_the_cache() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(some_songs());
    let jpeg = b"\xFF\xD8\xFF\xE0 placeholder cover bytes".to_vec();
    usdb.set_cover(1, jpeg.clone());
    let app = filled(&usdb).await;
    assert_eq!(cover_requests(&usdb, 1), 0, "nothing fetched before it is shown");

    for _ in 0..2 {
        let response = app
            .http()
            .get(app.url("/api/usdb/songs/1/cover"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "image/jpeg");
        assert_eq!(response.bytes().await.unwrap().to_vec(), jpeg);
    }

    assert_eq!(cover_requests(&usdb, 1), 1, "the second one came from the cache");
    let cached = app.appdata_dir().join("cache/usdb-covers/1.jpg");
    assert_eq!(std::fs::read(cached).unwrap(), jpeg);
}

#[tokio::test]
async fn a_song_without_a_cover_answers_404_and_caches_no_file() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(some_songs());
    let app = filled(&usdb).await;

    for _ in 0..2 {
        let response = app
            .http()
            .get(app.url("/api/usdb/songs/2/cover"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 404);
    }

    assert_eq!(cover_requests(&usdb, 2), 1, "USDB is asked once");
    let cache = app.appdata_dir().join("cache/usdb-covers");
    let files: Vec<_> = std::fs::read_dir(&cache)
        .map(|dir| dir.map(|entry| entry.unwrap().path()).collect())
        .unwrap_or_default();
    assert!(files.is_empty(), "no file is cached: {files:?}");
}

#[tokio::test]
async fn a_cover_usdb_answers_empty_counts_as_none() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(some_songs());
    usdb.set_cover(3, Vec::new());
    let app = filled(&usdb).await;

    let response = app
        .http()
        .get(app.url("/api/usdb/songs/3/cover"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    assert!(
        !app.appdata_dir()
            .join("cache/usdb-covers/3.jpg")
            .exists(),
        "no zero-byte cover"
    );
}

#[tokio::test]
async fn without_credentials_search_answers_empty_and_a_cover_is_not_found() {
    let app = TestApp::start().await;

    let found = search(&app, &UsdbSearchQuery::default()).await;
    assert_eq!(found.total, 0);
    let response = app
        .http()
        .get(app.url("/api/usdb/songs/1/cover"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn a_mirror_run_that_fails_tells_browsers_after_its_job_ended() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(some_songs());
    let app = filled(&usdb).await;
    let mut socket = app.connect_ws().await;
    usdb.script(
        Scripted::Error {
            status: 503,
            retry_after: None,
        },
        5,
    );

    let response = app
        .http()
        .post(app.url("/api/usdb/mirror/refetch"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);

    loop {
        if let ServerMessage::JobChanged { job } = socket.recv().await
            && matches!(job.state, JobState::Failed { .. })
        {
            break;
        }
    }
    // The section's notices and progress refetch on this notice; the
    // status it reads now says the run failed.
    loop {
        if let ServerMessage::Changed { topics } = socket.recv().await {
            assert_eq!(topics, [ChangeTopic::UsdbMirror]);
            break;
        }
    }
    let status: UsdbMirrorStatus = app.get_json("/api/usdb/mirror").await;
    assert_eq!(
        status.last_failure,
        Some(UserMessage::UsdbGaveUp { status: 503 })
    );
}
