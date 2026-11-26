//! The video picker (#194) against the fake USDB and the yt-dlp stub first
//! on `PATH`: nothing here reaches the network, and nothing needs an Unlock.
//!
//! The candidates are the `#VIDEO` tags of USDB's text, then the links in
//! its comments (newest first), then the yt-dlp search hits, without
//! repeats. Picker lookups run one at a time in their own queue, outside the
//! Download lane, and every yt-dlp call goes through the resolver that
//! prefers `/appdata/bin/yt-dlp` when it runs.

use std::sync::Arc;
use std::time::Duration;

use openstar::clock::ManualClock;
use openstar::jobs::{Lane, TestJob};
use openstar::usdb::{UsdbTimer, VirtualTimer};
use openstar_protocol::UserMessage;
use openstar_protocol::jobs::{JobId, JobList, JobState};
use openstar_protocol::usdb::{
    UsdbMirrorState, UsdbMirrorStatus, UsdbVideoCandidates, VideoDetails, VideoSource,
};
use openstar_test_harness::{
    AppFolders, FakeSong, FakeUsdb, TestApp, TestAppBuilder, YtDlpStub, YtDlpStubBehaviour,
};

/// The yt-dlp self-update is on, so the resolver may pick the own copy in
/// `/appdata/bin`; with no release server attached its checks fail
/// (a closed port) and change nothing.
fn builder(usdb: &FakeUsdb, stub: &YtDlpStub) -> TestAppBuilder {
    TestApp::builder()
        .var("OPENSTAR_YTDLP_AUTOUPDATE", "true")
        .usdb(usdb)
        .ytdlp_stub(stub)
        .clock(&ManualClock::new())
        .usdb_timer(Arc::new(VirtualTimer::new()) as Arc<dyn UsdbTimer>)
}

/// A fake USDB whose mirror holds song 1 as "Mirror Artist - Mirror Title".
async fn fake_usdb() -> FakeUsdb {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(vec![FakeSong::new(
        1,
        "Mirror Artist",
        "Mirror Title",
        1_700_000_000,
    )]);
    usdb
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

async fn candidates(app: &TestApp, id: u32) -> UsdbVideoCandidates {
    let response = app
        .http()
        .get(app.url(&format!("/api/usdb/songs/{id}/videos")))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "opening the picker for {id}");
    response.json().await.unwrap()
}

async fn details(app: &TestApp, url: &str) -> reqwest::Response {
    app.http()
        .get(app.url("/api/usdb/video-details"))
        .query(&[("url", url)])
        .send()
        .await
        .unwrap()
}

fn is_search(call: &[String]) -> bool {
    call.iter().any(|arg| arg.starts_with("ytsearch"))
}

#[tokio::test]
async fn candidates_come_tags_then_comments_then_search_hits_without_an_unlock() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let app = builder(&usdb, &stub).start().await;
    wait_for_fresh_mirror(&app).await;

    // No Unlock cookie: the picker is free to open.
    let found = candidates(&app, 1).await;

    let listed: Vec<(&str, VideoSource)> = found
        .candidates
        .iter()
        .map(|c| (c.url.as_str(), c.source))
        .collect();
    assert_eq!(
        listed,
        [
            (
                "https://www.youtube.com/watch?v=AAAAAAAAAAA",
                VideoSource::VideoTag
            ),
            (
                "https://www.youtube.com/watch?v=BBBBBBBBBBB",
                VideoSource::VideoTag
            ),
            (
                "https://www.youtube.com/watch?v=CCCCCCCCCCC",
                VideoSource::Comment
            ),
            ("https://vimeo.com/123456", VideoSource::Comment),
            (
                "https://www.youtube.com/watch?v=DDDDDDDDDDD",
                VideoSource::Comment
            ),
            // The comments' AAAAAAAAAAA is a tag already: not offered twice.
            (
                "https://www.youtube.com/watch?v=stubsearch1",
                VideoSource::Search
            ),
            (
                "https://www.youtube.com/watch?v=stubsearch2",
                VideoSource::Search
            ),
            (
                "https://www.youtube.com/watch?v=stubsearch3",
                VideoSource::Search
            ),
            (
                "https://www.youtube.com/watch?v=stubsearch4",
                VideoSource::Search
            ),
            (
                "https://www.youtube.com/watch?v=stubsearch5",
                VideoSource::Search
            ),
        ]
    );
    assert_eq!(found.search_failure, None);
    // gettxt-1: BPM 300 (0.05 s a beat), GAP 1 s, last Note ends at beat 22.
    let length = found.song_length_seconds.expect("a length");
    assert!((length - 2.1).abs() < 1e-9, "{length}");

    let hit = found.candidates[5]
        .details
        .as_ref()
        .expect("search hits carry details");
    assert_eq!(hit.title, "Mirror Artist - Mirror Title (stub hit 1)");
    assert!(hit.duration_seconds.is_some());
    assert!(hit.thumbnail.is_some());
    assert_eq!(found.candidates[0].details, None, "looked up one by one");

    let calls = stub.calls();
    assert_eq!(calls.len(), 1, "only the search ran: {calls:?}");
    assert_eq!(
        calls[0],
        [
            "--flat-playlist",
            "-j",
            "--match-filter",
            "url!*=/shorts/ & original_url!*=/shorts/",
            "--",
            "ytsearch5:Mirror Artist - Mirror Title",
        ]
    );
}

#[tokio::test]
async fn each_candidate_s_details_come_from_yt_dlp_and_a_failure_is_unavailable() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let app = builder(&usdb, &stub).start().await;

    let response = details(&app, "https://vimeo.com/123456").await;
    assert_eq!(response.status(), 200);
    let read: VideoDetails = response.json().await.unwrap();
    assert_eq!(read.title, "Stub video 1");
    assert_eq!(read.duration_seconds, Some(2.0));
    assert!(read.thumbnail.is_some());
    assert_eq!(
        stub.calls().last().unwrap(),
        &["-j", "--no-playlist", "--", "https://vimeo.com/123456"]
    );

    stub.script(
        YtDlpStubBehaviour::Fail {
            exit_code: 1,
            message: "ERROR: Video unavailable".to_owned(),
        },
        1,
    );
    let response = details(&app, "https://www.youtube.com/watch?v=CCCCCCCCCCC").await;
    assert_eq!(response.status(), 502);
    let reason: UserMessage = response.json().await.unwrap();
    assert_eq!(
        reason,
        UserMessage::ToolFailed {
            tool: "yt-dlp".to_owned(),
            exit_code: Some(1),
        }
    );

    // Only links are looked up, never options or local files.
    for url in ["--exec=rm", "file:///etc/passwd", ""] {
        assert_eq!(details(&app, url).await.status(), 400, "{url:?}");
    }
}

#[tokio::test]
async fn a_failed_search_still_offers_the_other_candidates() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let app = builder(&usdb, &stub).start().await;
    stub.script(
        YtDlpStubBehaviour::Fail {
            exit_code: 1,
            message: "ERROR: Unable to download".to_owned(),
        },
        1,
    );

    let found = candidates(&app, 1).await;

    assert_eq!(found.candidates.len(), 5);
    assert!(
        found
            .candidates
            .iter()
            .all(|c| c.source != VideoSource::Search)
    );
    assert_eq!(
        found.search_failure,
        Some(UserMessage::ToolFailed {
            tool: "yt-dlp".to_owned(),
            exit_code: Some(1),
        })
    );
}

#[tokio::test]
async fn a_song_not_mirrored_is_searched_by_its_text_headers() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(Vec::new());
    let stub = YtDlpStub::new();
    let app = builder(&usdb, &stub).start().await;

    candidates(&app, 1).await;

    let search = stub
        .calls()
        .into_iter()
        .find(|call| is_search(call))
        .unwrap();
    assert_eq!(
        search.last().unwrap(),
        "ytsearch5:Placeholder Artist - Re: Stacks"
    );
}

async fn enqueue(app: &TestApp, job: &TestJob) -> JobId {
    let response = app
        .http()
        .post(app.url("/api/test/jobs"))
        .json(job)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success(), "{}", response.status());
    response.json().await.unwrap()
}

#[tokio::test]
async fn lookups_run_one_at_a_time_and_running_downloads_do_not_delay_them() {
    let usdb = fake_usdb().await;
    let stub = YtDlpStub::new();
    let app = builder(&usdb, &stub).test_routes().start().await;

    // Fill the Download lane (cap 2) with jobs that run for a minute.
    let long = TestJob {
        lane: Lane::Downloads,
        steps: 600,
        step_ms: 100,
        exit_code: 0,
        marker_dir: None,
        fails_after_restart: false,
    };
    let jobs = [enqueue(&app, &long).await, enqueue(&app, &long).await];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let list: JobList = app.get_json("/api/jobs").await;
        let running = list
            .jobs
            .iter()
            .filter(|job| jobs.contains(&job.id) && matches!(job.state, JobState::Running { .. }))
            .count();
        if running == 2 {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "{list:?}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    stub.script(YtDlpStubBehaviour::Delay(Duration::from_millis(300)), 3);
    let started = tokio::time::Instant::now();
    let (first, second, third) = tokio::join!(
        details(&app, "https://example.invalid/1"),
        details(&app, "https://example.invalid/2"),
        details(&app, "https://example.invalid/3"),
    );
    assert_eq!(
        [first.status(), second.status(), third.status()],
        [200, 200, 200]
    );
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "the lookups waited for the Downloads"
    );

    let mut spans: Vec<(f64, f64)> = stub
        .call_spans()
        .into_iter()
        .map(|span| span.expect("every lookup ended"))
        .collect();
    assert_eq!(spans.len(), 3);
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    for pair in spans.windows(2) {
        assert!(pair[1].0 >= pair[0].1, "two lookups overlapped: {spans:?}");
    }

    let list: JobList = app.get_json("/api/jobs").await;
    assert!(
        list.jobs
            .iter()
            .filter(|job| jobs.contains(&job.id))
            .all(|job| matches!(job.state, JobState::Running { .. })),
        "the Downloads kept running: {list:?}"
    );
}

#[tokio::test]
async fn the_own_copy_in_appdata_bin_is_used_when_it_runs() {
    let usdb = fake_usdb().await;
    let on_path = YtDlpStub::new();
    let folders = AppFolders::new();
    let own = YtDlpStub::install_own_copy(folders.appdata_dir()).unwrap();
    let app = builder(&usdb, &on_path).folders(folders).start().await;

    assert_eq!(
        details(&app, "https://example.invalid/v").await.status(),
        200
    );

    let own_calls = openstar_test_harness::read_ytdlp_calls(&own);
    assert_eq!(own_calls.first().unwrap(), &["--version"], "checked first");
    assert_eq!(
        own_calls.last().unwrap().last().unwrap(),
        "https://example.invalid/v"
    );
    assert!(on_path.calls().is_empty(), "the image's copy never ran");
}

#[tokio::test]
async fn the_image_copy_is_used_when_the_own_copy_does_not_run() {
    let usdb = fake_usdb().await;
    let on_path = YtDlpStub::new();
    let folders = AppFolders::new();
    let own = YtDlpStub::install_own_copy(folders.appdata_dir()).unwrap();
    std::fs::write(own.join("behaviours"), "fail 1 broken\n").unwrap();
    let app = builder(&usdb, &on_path).folders(folders).start().await;

    assert_eq!(
        details(&app, "https://example.invalid/v").await.status(),
        200
    );

    let own_calls = openstar_test_harness::read_ytdlp_calls(&own);
    assert_eq!(own_calls, [["--version"]], "only the check ran");
    assert_eq!(on_path.calls().len(), 1);
}

#[tokio::test]
async fn the_image_copy_is_used_when_there_is_no_own_copy() {
    let usdb = fake_usdb().await;
    let on_path = YtDlpStub::new();
    let app = builder(&usdb, &on_path).start().await;

    assert_eq!(
        details(&app, "https://example.invalid/v").await.status(),
        200
    );
    assert_eq!(on_path.calls().len(), 1);
}
