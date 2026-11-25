//! The background job runner, driven from outside: test jobs are started
//! through the test-only `POST /api/test/jobs`, and what browsers see arrives
//! over the WebSocket and `GET /api/jobs`. The test job kind runs a harmless
//! `sh` child process that counts steps.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::{Duration, Instant};

use openstar::jobs::{Lane, TestJob};
use openstar_protocol::jobs::{Job, JobId, JobKind, JobList, JobState};
use openstar_protocol::{ClientMessage, ServerMessage, UserMessage};
use openstar_test_harness::{TestApp, WsClient};

async fn start() -> TestApp {
    TestApp::builder().test_routes().start().await
}

/// A connection, with the live state it is told first already read.
async fn connect(app: &TestApp) -> WsClient {
    let mut socket = app.connect_ws().await;
    match socket.recv().await {
        ServerMessage::LiveState { .. } => socket,
        other => panic!("expected the live state first, got {other:?}"),
    }
}

fn job(lane: Lane, steps: u32, step_ms: u32) -> TestJob {
    TestJob {
        lane,
        steps,
        step_ms,
        exit_code: 0,
        marker_dir: None,
        fails_after_restart: false,
    }
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

async fn cancel(app: &TestApp, id: JobId) {
    let response = app
        .http()
        .post(app.url(&format!("/api/test/jobs/{}/cancel", id.0)))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success(), "{}", response.status());
}

/// The next job update on `socket`, skipping every other message.
async fn next_job(socket: &mut WsClient) -> Job {
    loop {
        if let ServerMessage::JobChanged { job } = socket.recv().await {
            return job;
        }
    }
}

/// Reads job updates until `id` reaches a state that `done` accepts; returns
/// every state `id` went through, in order.
async fn follow(
    socket: &mut WsClient,
    id: JobId,
    done: impl Fn(&JobState) -> bool,
) -> Vec<JobState> {
    let mut seen = Vec::new();
    loop {
        let job = next_job(socket).await;
        if job.id == id {
            let finished = done(&job.state);
            seen.push(job.state);
            if finished {
                return seen;
            }
        }
    }
}

fn is_finished(state: &JobState) -> bool {
    matches!(state, JobState::Done | JobState::Failed { .. })
}

/// Waits up to `limit` for `path` to hold something, and returns it trimmed.
async fn read_marker(path: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && text.ends_with('\n')
        {
            return text.trim().to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "{} never appeared",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn progress_and_completion_reach_every_connected_browser() {
    let app = start().await;
    let mut a = connect(&app).await;
    let mut b = connect(&app).await;

    let id = enqueue(&app, &job(Lane::Downloads, 4, 30)).await;

    for socket in [&mut a, &mut b] {
        let states = follow(socket, id, is_finished).await;
        assert_eq!(states.first(), Some(&JobState::Queued));
        assert_eq!(states.last(), Some(&JobState::Done));
        let percents: Vec<u8> = states
            .iter()
            .filter_map(|s| match s {
                JobState::Running { percent: Some(p) } => Some(*p),
                _ => None,
            })
            .collect();
        assert_eq!(percents, vec![25, 50, 75, 100]);
    }

    let list: JobList = app.get_json("/api/jobs").await;
    assert_eq!(
        list.jobs,
        vec![Job {
            id,
            kind: JobKind::Test,
            state: JobState::Done
        }]
    );
}

#[tokio::test]
async fn a_failing_child_fails_its_job_with_a_code_and_parameters() {
    let app = start().await;
    let mut socket = connect(&app).await;
    let mut failing = job(Lane::Ffmpeg, 1, 0);
    failing.exit_code = 3;

    let id = enqueue(&app, &failing).await;

    let states = follow(&mut socket, id, is_finished).await;
    assert_eq!(
        states.last(),
        Some(&JobState::Failed {
            reason: UserMessage::ToolFailed {
                tool: "sh".to_owned(),
                exit_code: Some(3)
            }
        })
    );
    let list: JobList = app.get_json("/api/jobs").await;
    assert_eq!(list.jobs[0].state, *states.last().unwrap());
}

/// Starts `cap + 2` jobs in `lane` and checks that at most `cap` run at once
/// and that they start in the order they were queued.
async fn lane_runs_at_most(lane: Lane, cap: usize) {
    let app = start().await;
    let mut socket = connect(&app).await;
    let mut ids = Vec::new();
    for _ in 0..cap + 2 {
        ids.push(enqueue(&app, &job(lane, 3, 100)).await);
    }

    let mut running = BTreeSet::new();
    let mut started = Vec::new();
    let mut finished = 0;
    let mut most = 0;
    while finished < ids.len() {
        let job = next_job(&mut socket).await;
        match job.state {
            JobState::Running { .. } => {
                if running.insert(job.id) {
                    started.push(job.id);
                }
                most = most.max(running.len());
            }
            JobState::Done => {
                running.remove(&job.id);
                finished += 1;
            }
            JobState::Failed { reason } => panic!("job failed: {reason:?}"),
            JobState::Queued => {}
        }
    }
    assert_eq!(most, cap, "{lane:?}");
    assert_eq!(
        started, ids,
        "{lane:?} starts jobs in the order they were queued"
    );
}

#[tokio::test]
async fn the_downloads_lane_runs_at_most_two_jobs_at_once() {
    lane_runs_at_most(Lane::Downloads, 2).await;
}

#[tokio::test]
async fn the_ffmpeg_lane_runs_at_most_two_jobs_at_once() {
    lane_runs_at_most(Lane::Ffmpeg, 2).await;
}

#[tokio::test]
async fn the_pitch_track_lane_runs_one_job_at_a_time() {
    lane_runs_at_most(Lane::PitchTrack, 1).await;
}

#[tokio::test]
async fn the_pitch_track_lane_runs_its_child_at_low_cpu_priority() {
    let app = start().await;
    let mut socket = connect(&app).await;
    let markers = tempfile::tempdir().unwrap();
    let mut niceness = BTreeMap::new();
    for lane in [Lane::PitchTrack, Lane::Downloads, Lane::Ffmpeg] {
        let dir = markers.path().join(format!("{lane:?}"));
        let mut marked = job(lane, 1, 0);
        marked.marker_dir = Some(dir.to_string_lossy().into_owned());
        let id = enqueue(&app, &marked).await;
        follow(&mut socket, id, is_finished).await;
        let nice: i32 = read_marker(&dir.join("nice")).await.parse().unwrap();
        niceness.insert(format!("{lane:?}"), nice);
    }
    assert_eq!(niceness["PitchTrack"], 19, "{niceness:?}");
    assert!(niceness["Downloads"] < 19, "{niceness:?}");
    assert!(niceness["Ffmpeg"] < 19, "{niceness:?}");
}

#[tokio::test]
async fn cancelling_a_running_job_stops_its_child() {
    let app = start().await;
    let mut socket = connect(&app).await;
    let markers = tempfile::tempdir().unwrap();
    let mut long = job(Lane::Downloads, 1000, 50);
    long.marker_dir = Some(markers.path().to_string_lossy().into_owned());
    let id = enqueue(&app, &long).await;
    follow(&mut socket, id, |s| matches!(s, JobState::Running { .. })).await;
    let pid = read_marker(&markers.path().join("pid")).await;
    let proc = Path::new("/proc").join(&pid);
    assert!(proc.exists(), "the child runs");

    cancel(&app, id).await;

    let states = follow(&mut socket, id, is_finished).await;
    assert_eq!(
        states.last(),
        Some(&JobState::Failed {
            reason: UserMessage::JobCancelled
        })
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    while proc.exists() {
        assert!(Instant::now() < deadline, "the child {pid} still runs");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn cancelling_a_queued_job_means_it_never_runs() {
    let app = start().await;
    let mut socket = connect(&app).await;
    let first = enqueue(&app, &job(Lane::PitchTrack, 1000, 50)).await;
    let second = enqueue(&app, &job(Lane::PitchTrack, 1, 0)).await;
    follow(&mut socket, first, |s| {
        matches!(s, JobState::Running { .. })
    })
    .await;

    cancel(&app, second).await;
    let states = follow(&mut socket, second, is_finished).await;
    assert!(!states.iter().any(|s| matches!(s, JobState::Running { .. })));
    assert_eq!(
        states.last(),
        Some(&JobState::Failed {
            reason: UserMessage::JobCancelled
        })
    );
    cancel(&app, first).await;
}

#[tokio::test]
async fn a_job_interrupted_by_a_restart_runs_again_from_the_start() {
    let mut app = start().await;
    let mut socket = connect(&app).await;
    let markers = tempfile::tempdir().unwrap();
    let mut interrupted = job(Lane::PitchTrack, 20, 100);
    interrupted.marker_dir = Some(markers.path().to_string_lossy().into_owned());
    let id = enqueue(&app, &interrupted).await;
    let waiting = enqueue(&app, &job(Lane::PitchTrack, 1, 0)).await;
    follow(
        &mut socket,
        id,
        |s| matches!(s, JobState::Running { percent: Some(p) } if *p >= 10),
    )
    .await;

    app.restart().await;

    // Job state survived: both jobs are still known after the restart.
    let list: JobList = app.get_json("/api/jobs").await;
    let ids: Vec<JobId> = list.jobs.iter().map(|j| j.id).collect();
    assert_eq!(ids, vec![id, waiting]);
    assert!(list.jobs.iter().all(|j| !is_finished(&j.state)), "{list:?}");

    let mut socket = connect(&app).await;
    follow(&mut socket, id, is_finished).await;
    let states = follow(&mut socket, waiting, is_finished).await;
    assert_eq!(states.last(), Some(&JobState::Done));
    let runs = read_marker(&markers.path().join("runs")).await;
    assert_eq!(runs.lines().count(), 2, "the child started again: {runs:?}");
    let list: JobList = app.get_json("/api/jobs").await;
    assert!(
        list.jobs.iter().all(|j| j.state == JobState::Done),
        "{list:?}"
    );
}

#[tokio::test]
async fn a_kind_that_does_not_run_again_fails_when_a_restart_interrupts_it() {
    let mut app = start().await;
    let mut socket = connect(&app).await;
    let mut interrupted = job(Lane::Ffmpeg, 1000, 50);
    interrupted.fails_after_restart = true;
    let id = enqueue(&app, &interrupted).await;
    follow(&mut socket, id, |s| matches!(s, JobState::Running { .. })).await;

    app.restart().await;

    let list: JobList = app.get_json("/api/jobs").await;
    assert_eq!(
        list.jobs,
        vec![Job {
            id,
            kind: JobKind::Test,
            state: JobState::Failed {
                reason: UserMessage::JobInterrupted
            }
        }]
    );
}

/// One worker thread for the whole app, so spare threads cannot hide a job
/// that holds the runtime.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn a_websocket_round_trip_is_answered_promptly_while_every_lane_is_full() {
    const BOUND: Duration = Duration::from_millis(100);
    let app = start().await;
    let mut socket = connect(&app).await;
    let mut ids = BTreeSet::new();
    // Each child keeps a CPU busy and floods its output with progress.
    for (lane, cap) in [
        (Lane::Downloads, 2),
        (Lane::Ffmpeg, 2),
        (Lane::PitchTrack, 1),
    ] {
        for _ in 0..cap + 1 {
            ids.insert(enqueue(&app, &job(lane, 50_000_000, 0)).await);
        }
    }
    let mut running = BTreeSet::new();
    while running.len() < 5 {
        let job = next_job(&mut socket).await;
        if matches!(job.state, JobState::Running { .. }) {
            running.insert(job.id);
        }
    }

    for nonce in 0..20 {
        let sent = Instant::now();
        socket.send(&ClientMessage::Ping { nonce }).await;
        loop {
            match socket.recv().await {
                ServerMessage::Pong { nonce: n } if n == nonce => break,
                ServerMessage::JobChanged { .. } => {}
                other => panic!("unexpected {other:?}"),
            }
        }
        let took = sent.elapsed();
        assert!(took < BOUND, "round trip {nonce} took {took:?}");
    }
    for id in ids {
        cancel(&app, id).await;
    }
}
