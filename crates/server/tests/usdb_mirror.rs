//! The USDB mirror (#147) against the fake USDB: the first fill, the update
//! at every start, the update the Downloads section asks for, the full
//! refetch (weekly and by hand), no runs without credentials, and the
//! progress on the WebSocket. USDB waits run on a virtual timer and the
//! server on a manual clock, so no test waits a real second of pacing or a
//! real day.

use std::sync::Arc;
use std::time::Duration;

use openstar::clock::ManualClock;
use openstar::usdb::{UsdbTimer, VirtualTimer};
use openstar_protocol::jobs::{JobKind, JobList, JobState};
use openstar_protocol::usdb::{UsdbMirrorState, UsdbMirrorStatus};
use openstar_protocol::{ChangeTopic, ServerMessage, UserMessage};
use openstar_test_harness::{FakeSong, FakeUsdb, RecordedRequest, Scripted, TestApp};

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

/// An app on `usdb` with a manual clock and a virtual USDB timer.
async fn app_on(usdb: &FakeUsdb, clock: &ManualClock, timer: &Arc<VirtualTimer>) -> TestApp {
    TestApp::builder()
        .usdb(usdb)
        .clock(clock)
        .usdb_timer(timer.clone() as Arc<dyn UsdbTimer>)
        .start()
        .await
}

async fn mirror(app: &TestApp) -> UsdbMirrorStatus {
    app.get_json("/api/usdb/mirror").await
}

async fn post(app: &TestApp, path: &str) -> UsdbMirrorStatus {
    let response = app.http().post(app.url(path)).send().await.unwrap();
    assert_eq!(response.status(), 200, "POST {path}");
    response.json().await.unwrap()
}

/// Polls the mirror's status until `done` holds for it.
async fn wait_for(
    app: &TestApp,
    what: &str,
    done: impl Fn(&UsdbMirrorStatus) -> bool,
) -> UsdbMirrorStatus {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let status = mirror(app).await;
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

async fn wait_until_fresh(app: &TestApp) -> UsdbMirrorStatus {
    wait_for(app, "fresh", |s| s.state == UsdbMirrorState::Fresh).await
}

/// The form of each song list request, as `start` values, after the first
/// `skip` requests.
fn list_starts(requests: &[RecordedRequest], skip: usize) -> Vec<u32> {
    requests
        .iter()
        .skip(skip)
        .filter(|r| r.query_param("link") == Some("list"))
        .map(|r| {
            assert!(
                r.body.starts_with("limit=100&start=")
                    && r.body.ends_with("&order=lastchange&ud=desc"),
                "a list request asks for 100 rows newest change first: {}",
                r.body
            );
            let start = r.body.split('&').nth(1).unwrap();
            start.trim_start_matches("start=").parse().unwrap()
        })
        .collect()
}

async fn mirror_jobs(app: &TestApp) -> Vec<(JobKind, JobState)> {
    app.get_json::<JobList>("/api/jobs")
        .await
        .jobs
        .into_iter()
        .filter(|job| {
            matches!(
                job.kind,
                JobKind::UsdbMirrorRefetch | JobKind::UsdbMirrorUpdate
            )
        })
        .map(|job| (job.kind, job.state))
        .collect()
}

#[tokio::test]
async fn the_first_fill_reads_every_page_of_100_until_the_list_ends() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(FakeSong::many(1, 250, 1_700_000_000));
    let clock = ManualClock::new();
    let timer = Arc::new(VirtualTimer::new());
    let app = app_on(&usdb, &clock, &timer).await;

    let status = wait_until_fresh(&app).await;

    assert_eq!(status.songs, 250);
    assert_eq!(status.last_full_ms, status.last_refreshed_ms);
    assert!(status.last_full_ms.is_some());
    assert_eq!(status.last_failure, None);
    // Three pages, the last one short, then the list's head again for songs
    // that changed while it ran.
    assert_eq!(list_starts(&usdb.requests(), 0), [0, 100, 200, 0]);
    assert_eq!(
        mirror_jobs(&app).await,
        [(JobKind::UsdbMirrorRefetch, JobState::Done)]
    );
    // Through the client's queue: every request after the first was paced.
    let requests = usdb.requests().len();
    assert!(
        timer.waits().len() >= requests - 1,
        "{} waits for {requests} requests",
        timer.waits().len()
    );
}

#[tokio::test]
async fn songs_are_kept_page_by_page_and_the_next_request_fills_again() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(FakeSong::many(1, 250, 1_700_000_000));
    // Login, profile, the first list page; then USDB fails the second page
    // until the client gives up.
    usdb.script(Scripted::Page, 3);
    usdb.script(
        Scripted::Error {
            status: 503,
            retry_after: Some(7),
        },
        5,
    );
    let clock = ManualClock::new();
    let timer = Arc::new(VirtualTimer::new());
    let app = app_on(&usdb, &clock, &timer).await;

    let status = wait_for(&app, "failed", |s| s.last_failure.is_some()).await;

    assert_eq!(
        status.last_failure,
        Some(UserMessage::UsdbGaveUp { status: 503 })
    );
    assert_eq!(status.state, UsdbMirrorState::Incomplete);
    assert_eq!(status.songs, 100, "the first page stays searchable");
    assert_eq!(status.last_full_ms, None);
    // The client's backoff held for the mirror's request.
    let sevens = timer
        .waits()
        .iter()
        .filter(|wait| **wait == Duration::from_secs(7))
        .count();
    assert_eq!(sevens, 4, "Retry-After between the 5 tries");

    // The Downloads section opens: the unfinished fill starts again.
    let asked = post(&app, "/api/usdb/mirror/refresh").await;
    assert!(
        matches!(asked.state, UsdbMirrorState::Filling { .. }),
        "{asked:?}"
    );
    let status = wait_until_fresh(&app).await;
    assert_eq!(status.songs, 250);
    assert_eq!(status.last_failure, None);
}

#[tokio::test]
async fn every_start_updates_until_the_first_row_older_than_the_newest_stored() {
    let usdb = FakeUsdb::start().await;
    let newest = 1_700_000_000;
    usdb.set_songs(FakeSong::many(1, 150, newest));
    let clock = ManualClock::new();
    let timer = Arc::new(VirtualTimer::new());
    let mut app = app_on(&usdb, &clock, &timer).await;
    let filled = wait_until_fresh(&app).await;
    assert_eq!(filled.songs, 150);

    // Meanwhile on USDB: 120 new songs, song 5 changed, song 150 deleted.
    let mut songs = FakeSong::many(1, 149, newest);
    songs[4].title = "Changed Title".to_owned();
    songs[4].last_change = newest + 500;
    songs.extend(FakeSong::many(1001, 120, newest + 1000));
    usdb.set_songs(songs);
    clock.advance(Duration::from_secs(60));
    let before = usdb.requests().len();

    app.restart().await;
    let status = wait_for(&app, "updated", |s| {
        s.state == UsdbMirrorState::Fresh && s.last_refreshed_ms > filled.last_refreshed_ms
    })
    .await;

    // Newest first: 100 new songs, then 20 new, song 5, song 1 (as new as
    // the newest stored) and song 2, older: the update stops there.
    assert_eq!(list_starts(&usdb.requests(), before), [0, 100]);
    assert_eq!(status.songs, 270, "an update adds and changes, never drops");
    assert_eq!(status.last_full_ms, filled.last_full_ms);
    assert_eq!(
        mirror_jobs(&app).await.last(),
        Some(&(JobKind::UsdbMirrorUpdate, JobState::Done))
    );
}

#[tokio::test]
async fn the_downloads_section_gets_an_update_only_when_the_mirror_is_over_a_day_old() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(FakeSong::many(1, 10, 1_700_000_000));
    let clock = ManualClock::new();
    let timer = Arc::new(VirtualTimer::new());
    let app = app_on(&usdb, &clock, &timer).await;
    let filled = wait_until_fresh(&app).await;
    let before = usdb.requests().len();

    clock.advance(DAY - Duration::from_secs(60));
    let asked = post(&app, "/api/usdb/mirror/refresh").await;
    assert_eq!(asked.state, UsdbMirrorState::Fresh);
    assert_eq!(
        usdb.requests().len(),
        before,
        "a fresh mirror is left alone"
    );

    clock.advance(Duration::from_secs(120));
    assert_eq!(mirror(&app).await.state, UsdbMirrorState::Stale);
    let asked = post(&app, "/api/usdb/mirror/refresh").await;
    assert!(
        matches!(asked.state, UsdbMirrorState::Refreshing { full: false, .. }),
        "{asked:?}"
    );
    let status = wait_until_fresh(&app).await;
    assert!(status.last_refreshed_ms > filled.last_refreshed_ms);
    assert_eq!(status.last_full_ms, filled.last_full_ms);
    assert_eq!(list_starts(&usdb.requests(), before), [0]);
}

#[tokio::test]
async fn a_full_refetch_by_hand_needs_no_pin_and_drops_songs_usdb_no_longer_has() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(FakeSong::many(1, 120, 1_700_000_000));
    let clock = ManualClock::new();
    let timer = Arc::new(VirtualTimer::new());
    let app = app_on(&usdb, &clock, &timer).await;
    let filled = wait_until_fresh(&app).await;
    assert_eq!(filled.songs, 120);

    let mut songs = FakeSong::many(1, 120, 1_700_000_000);
    songs.retain(|song| ![3, 60, 110].contains(&song.id));
    usdb.set_songs(songs);
    clock.advance(Duration::from_secs(60));
    let mut ws = app.connect_ws().await;

    // No Unlock: the request carries no cookie at all.
    let asked = post(&app, "/api/usdb/mirror/refetch").await;
    assert!(
        matches!(asked.state, UsdbMirrorState::Refreshing { full: true, .. }),
        "{asked:?}"
    );
    let status = wait_for(&app, "refetched", |s| {
        s.state == UsdbMirrorState::Fresh && s.last_full_ms > filled.last_full_ms
    })
    .await;
    assert_eq!(status.songs, 117);

    // Progress and completion reached the open WebSocket.
    let (mut percents, mut notices, mut done) = (Vec::new(), 0, false);
    while !done {
        match ws.recv().await {
            ServerMessage::JobChanged { job } if job.kind == JobKind::UsdbMirrorRefetch => {
                match job.state {
                    JobState::Running {
                        percent: Some(percent),
                    } => percents.push(percent),
                    JobState::Done => done = true,
                    JobState::Failed { reason } => panic!("the refetch failed: {reason:?}"),
                    JobState::Queued | JobState::Running { percent: None } => {}
                }
            }
            ServerMessage::Changed { topics } if topics.contains(&ChangeTopic::UsdbMirror) => {
                notices += 1;
            }
            _ => {}
        }
    }
    assert!(!percents.is_empty(), "the refetch reported its progress");
    assert!(percents.windows(2).all(|w| w[0] < w[1]), "{percents:?}");
    assert!(notices >= 2, "a notice per stored page: {notices}");
}

#[tokio::test]
async fn a_start_a_week_after_the_last_full_refetch_runs_a_full_refetch() {
    let usdb = FakeUsdb::start().await;
    usdb.set_songs(FakeSong::many(1, 20, 1_700_000_000));
    let clock = ManualClock::new();
    let timer = Arc::new(VirtualTimer::new());
    let mut app = app_on(&usdb, &clock, &timer).await;
    let filled = wait_until_fresh(&app).await;

    usdb.set_songs(FakeSong::many(1, 19, 1_700_000_000));
    clock.advance(7 * DAY + Duration::from_secs(60));
    app.restart().await;

    let status = wait_for(&app, "refetched", |s| {
        s.state == UsdbMirrorState::Fresh && s.last_full_ms > filled.last_full_ms
    })
    .await;
    assert_eq!(status.songs, 19);
    assert_eq!(
        mirror_jobs(&app).await.last(),
        Some(&(JobKind::UsdbMirrorRefetch, JobState::Done))
    );
}

#[tokio::test]
async fn without_credentials_no_mirror_job_runs_and_the_state_says_why() {
    let app = TestApp::start().await;
    let unavailable = UsdbMirrorState::Unavailable {
        reason: UserMessage::UsdbCredentialsMissing,
    };

    assert_eq!(mirror(&app).await.state, unavailable);
    assert_eq!(
        post(&app, "/api/usdb/mirror/refresh").await.state,
        unavailable
    );
    assert_eq!(
        post(&app, "/api/usdb/mirror/refetch").await.state,
        unavailable
    );
    assert_eq!(mirror_jobs(&app).await, []);
    assert_eq!(mirror(&app).await.songs, 0);
}
