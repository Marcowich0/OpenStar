//! The background job runner: Downloads, media conversions, Song loudness
//! measurements and the Pitch track run here, never on the paths that relay
//! Pitch readings.
//!
//! One task owns the runner state and takes [`Command`]s on a channel, like
//! the live-state task. Job state is kept in SQLite (`store`). Jobs run in
//! [`Lane`]s with fixed caps; extra jobs wait their turn in the order they
//! were queued. A running job gets a [`Slot`], and its child processes start
//! only through that slot ([`child`]), so the lane's cap holds for them too.
//! Every change to a job reaches every browser as
//! [`ServerMessage::JobChanged`]; failures are [`UserMessage`] codes.
//!
//! **Adding a job kind** (the areas own theirs: #46, #47, #57): add a
//! [`JobKind`] in the protocol crate and a [`JobParams`] variant here, then
//! give it its lane, its [`AfterRestart`] rule and its `run` in the matches
//! on [`JobParams`]. A kind's `run` reports progress with
//! [`Progress::report`] and starts child processes with [`Slot::command`].
//! A kind that runs again from scratch after a restart must expect what an
//! interrupted run left behind (a Download removes its temporary folder first).

mod child;
pub(crate) mod http;
mod store;
mod test_kind;

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use openstar_protocol::jobs::{Job, JobId, JobKind, JobState};
use openstar_protocol::{ChangeTopic, ServerMessage, UserMessage};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

pub use child::{Slot, ToolCommand};
use store::StoredState;
pub use test_kind::TestJob;

use crate::db::Database;
use crate::live::LiveHandle;

/// How many commands may wait for the runner task.
const COMMAND_CAPACITY: usize = 1024;

/// How long a stopping server waits for cancelled jobs to end before it
/// aborts them (their children are killed when dropped).
const STOP_WAIT: Duration = Duration::from_secs(3);

/// A group of jobs with a fixed cap on how many run at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Lane {
    /// Downloads (yt-dlp): at most 2 at once.
    Downloads,
    /// Media conversions and Song loudness measurements (ffmpeg), shared:
    /// at most 2 at once.
    Ffmpeg,
    /// The Pitch track job: one at a time, at low CPU priority.
    PitchTrack,
    /// The USDB mirror's runs: one at a time, so a refetch and an update
    /// never write the mirror together. Their requests also queue in the
    /// USDB client, behind and between Downloads' ones.
    UsdbMirror,
}

impl Lane {
    const ALL: [Self; 4] = [
        Self::Downloads,
        Self::Ffmpeg,
        Self::PitchTrack,
        Self::UsdbMirror,
    ];

    /// How many of this lane's jobs run at once.
    pub fn cap(self) -> usize {
        match self {
            Self::Downloads | Self::Ffmpeg => 2,
            Self::PitchTrack | Self::UsdbMirror => 1,
        }
    }

    /// Whether this lane's child processes run at low CPU priority.
    pub fn low_priority(self) -> bool {
        matches!(self, Self::PitchTrack)
    }
}

/// What happens to a job of a kind when a restart interrupted it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterRestart {
    /// It is queued again and runs again from the start (Downloads).
    StartAgain,
    /// It fails with [`UserMessage::JobInterrupted`].
    Fail,
}

/// A job's kind and parameters, stored as JSON in its row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JobParams {
    Test(TestJob),
    Conversion(crate::library::Conversion),
    Loudness(crate::library::Measurement),
    PitchTrack(crate::library::PitchTrackJob),
    UsdbMirrorRefetch,
    UsdbMirrorUpdate,
}

impl JobParams {
    pub fn kind(&self) -> JobKind {
        match self {
            Self::Test(_) => JobKind::Test,
            Self::Conversion(_) => JobKind::Conversion,
            Self::Loudness(_) => JobKind::Loudness,
            Self::PitchTrack(_) => JobKind::PitchTrack,
            Self::UsdbMirrorRefetch => JobKind::UsdbMirrorRefetch,
            Self::UsdbMirrorUpdate => JobKind::UsdbMirrorUpdate,
        }
    }

    pub fn lane(&self) -> Lane {
        match self {
            Self::Test(job) => job.lane,
            Self::Conversion(_) | Self::Loudness(_) => Lane::Ffmpeg,
            Self::PitchTrack(_) => Lane::PitchTrack,
            Self::UsdbMirrorRefetch | Self::UsdbMirrorUpdate => Lane::UsdbMirror,
        }
    }

    pub fn after_restart(&self) -> AfterRestart {
        match self {
            Self::Test(job) if job.fails_after_restart => AfterRestart::Fail,
            Self::Test(_) => AfterRestart::StartAgain,
            // It removes what an interrupted run left in the cache first.
            Self::Conversion(_) => AfterRestart::StartAgain,
            // It picks its file again when it starts.
            Self::Loudness(_) => AfterRestart::StartAgain,
            // It overwrites what an interrupted run left, and finds the
            // track cached when an earlier job already wrote it.
            Self::PitchTrack(_) => AfterRestart::StartAgain,
            // Rows are stored page by page and a run only ever adds or
            // updates them until its end, so starting again is safe.
            Self::UsdbMirrorRefetch | Self::UsdbMirrorUpdate => AfterRestart::StartAgain,
        }
    }

    async fn run(self, ctx: &mut JobContext) -> Result<(), UserMessage> {
        match self {
            Self::Test(job) => job.run(ctx).await,
            Self::Conversion(job) => job.run(ctx).await,
            Self::Loudness(job) => job.run(ctx).await,
            Self::PitchTrack(job) => job.run(ctx).await,
            Self::UsdbMirrorRefetch => crate::usdb::mirror::refetch(ctx).await,
            Self::UsdbMirrorUpdate => crate::usdb::mirror::update(ctx).await,
        }
    }
}

/// What a running job is handed.
pub struct JobContext {
    pub progress: Progress,
    pub slot: Slot,
    pub(crate) env: JobEnv,
    /// `None` in runners started without it (unit tests of other areas).
    pub(crate) usdb: Option<UsdbEnv>,
}

/// What every job may use besides its slot: the database, the live-state
/// task (for change notices) and the folders from the settings.
#[derive(Clone)]
pub(crate) struct JobEnv {
    pub(crate) db: Database,
    pub(crate) live: LiveHandle,
    pub(crate) songs_dir: PathBuf,
    pub(crate) appdata_dir: PathBuf,
}

/// What the USDB mirror's jobs use besides the [`JobEnv`]: the server's one
/// USDB client and its clock.
#[derive(Clone)]
pub(crate) struct UsdbEnv {
    pub(crate) usdb: crate::usdb::UsdbClient,
    pub(crate) clock: crate::clock::Clock,
}

/// Reports a running job's progress to every browser.
pub struct Progress {
    id: JobId,
    commands: mpsc::Sender<Command>,
    /// The last percentage sent, or [`NO_PERCENT`].
    last: AtomicU8,
}

const NO_PERCENT: u8 = u8::MAX;

impl Progress {
    /// Reports how far the job is, from 0 to 100. Only a changed percentage
    /// is sent, so browsers get at most about a hundred updates per job.
    pub fn report(&self, percent: u8) {
        let percent = percent.min(100);
        if self.last.swap(percent, Ordering::Relaxed) == percent {
            return;
        }
        // Progress is not worth waiting for: if the runner is busy, skip it.
        let _ = self.commands.try_send(Command::Progress {
            id: self.id,
            percent,
        });
    }

    /// Another reporter for the same job, owned, for work the job hands to
    /// a thread of its own (the Pitch track's detector).
    pub(crate) fn detached(&self) -> Self {
        Self {
            id: self.id,
            commands: self.commands.clone(),
            last: AtomicU8::new(self.last.load(Ordering::Relaxed)),
        }
    }
}

/// What a handler (or a job) asks of the runner task.
enum Command {
    Enqueue {
        params: JobParams,
        reply: oneshot::Sender<anyhow::Result<JobId>>,
    },
    Progress {
        id: JobId,
        percent: u8,
    },
    Finished {
        id: JobId,
        result: Result<(), UserMessage>,
    },
    Cancel {
        id: JobId,
        reply: oneshot::Sender<bool>,
    },
    List {
        reply: oneshot::Sender<Vec<Job>>,
    },
    Shutdown {
        done: oneshot::Sender<()>,
    },
}

/// A handle to the runner task. Cheap to clone.
#[derive(Clone)]
pub struct Jobs {
    commands: mpsc::Sender<Command>,
}

impl Jobs {
    /// A runner whose USDB mirror jobs cannot run, for other areas' tests.
    #[cfg(test)]
    pub(crate) async fn start(env: JobEnv, tool_path: Option<String>) -> anyhow::Result<Self> {
        Self::start_with_usdb(env, None, tool_path).await
    }

    /// Loads the kept jobs, applies each interrupted job's [`AfterRestart`]
    /// rule, then starts the runner, which starts queued jobs at once.
    /// `tool_path` is the `PATH` child processes run with; `usdb` is what the
    /// USDB mirror's jobs use.
    pub(crate) async fn start_with_usdb(
        env: JobEnv,
        usdb: Option<UsdbEnv>,
        tool_path: Option<String>,
    ) -> anyhow::Result<Self> {
        let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
        let mut runner = Runner {
            db: env.db.clone(),
            live: env.live.clone(),
            env,
            usdb,
            tool_path,
            commands: commands.clone(),
            jobs: BTreeMap::new(),
            queues: HashMap::new(),
            running: HashMap::new(),
        };
        runner.reload().await?;
        tokio::spawn(runner.run(receiver));
        Ok(Self { commands })
    }

    /// Stores and queues a job; `Err` once the runner has stopped or the
    /// database failed.
    pub async fn enqueue(&self, params: JobParams) -> anyhow::Result<JobId> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::Enqueue { params, reply })
            .await
            .map_err(|_| anyhow::anyhow!("the job runner has stopped"))?;
        answer.await?
    }

    /// Cancels a queued or running job (a running job's child is killed).
    /// False if no such job is queued or running.
    pub async fn cancel(&self, id: JobId) -> bool {
        let (reply, answer) = oneshot::channel();
        if self
            .commands
            .send(Command::Cancel { id, reply })
            .await
            .is_err()
        {
            return false;
        }
        answer.await.unwrap_or(false)
    }

    /// Every kept job, oldest first; `None` once the runner has stopped.
    pub async fn list(&self) -> Option<Vec<Job>> {
        let (reply, answer) = oneshot::channel();
        self.commands.send(Command::List { reply }).await.ok()?;
        answer.await.ok()
    }

    /// Stops every running job (its child is killed) without recording an
    /// end, so the next start applies the [`AfterRestart`] rules. Returns
    /// once nothing of the runner is left.
    pub async fn shutdown(&self) {
        let (done, stopped) = oneshot::channel();
        if self.commands.send(Command::Shutdown { done }).await.is_ok() {
            let _ = stopped.await;
        }
    }
}

struct Entry {
    /// `None` when the stored parameters could not be read (the job failed).
    params: Option<JobParams>,
    job: Job,
}

struct Running {
    lane: Lane,
    cancel: watch::Sender<bool>,
    task: JoinHandle<()>,
}

/// Owned by the runner task alone.
struct Runner {
    db: Database,
    live: LiveHandle,
    env: JobEnv,
    usdb: Option<UsdbEnv>,
    tool_path: Option<String>,
    /// Handed to running jobs, so they can report back.
    commands: mpsc::Sender<Command>,
    jobs: BTreeMap<JobId, Entry>,
    queues: HashMap<Lane, VecDeque<JobId>>,
    running: HashMap<JobId, Running>,
}

impl Runner {
    /// Loads every kept job and applies the restart rules.
    async fn reload(&mut self) -> anyhow::Result<()> {
        for row in store::load(&self.db).await? {
            let params = serde_json::from_str::<JobParams>(&row.params)
                .inspect_err(|error| {
                    tracing::error!(%error, job = row.id.0, "reading a stored job");
                })
                .ok();
            let kind = params.as_ref().map_or(JobKind::Test, JobParams::kind);
            let mut state = match row.state {
                StoredState::Queued => JobState::Queued,
                StoredState::Running => JobState::Running { percent: None },
                StoredState::Done => JobState::Done,
                StoredState::Failed => JobState::Failed {
                    reason: row
                        .error
                        .as_deref()
                        .and_then(|e| serde_json::from_str(e).ok())
                        .unwrap_or(UserMessage::ServerError),
                },
            };
            let unfinished = matches!(state, JobState::Queued | JobState::Running { .. });
            match (&params, &state) {
                (None, _) if unfinished => {
                    state = JobState::Failed {
                        reason: UserMessage::ServerError,
                    };
                    store::set_state(
                        &self.db,
                        row.id,
                        StoredState::Failed,
                        Some(&UserMessage::ServerError),
                    )
                    .await?;
                }
                (Some(params), JobState::Running { .. }) => match params.after_restart() {
                    AfterRestart::StartAgain => {
                        tracing::info!(
                            job = row.id.0,
                            "a restart interrupted a job: it starts again"
                        );
                        state = JobState::Queued;
                        store::set_state(&self.db, row.id, StoredState::Queued, None).await?;
                    }
                    AfterRestart::Fail => {
                        tracing::info!(job = row.id.0, "a restart interrupted a job: it failed");
                        let reason = UserMessage::JobInterrupted;
                        store::set_state(&self.db, row.id, StoredState::Failed, Some(&reason))
                            .await?;
                        state = JobState::Failed { reason };
                    }
                },
                _ => {}
            }
            if let (Some(params), JobState::Queued) = (&params, &state) {
                self.queues
                    .entry(params.lane())
                    .or_default()
                    .push_back(row.id);
            }
            self.jobs.insert(
                row.id,
                Entry {
                    params,
                    job: Job {
                        id: row.id,
                        kind,
                        state,
                    },
                },
            );
        }
        Ok(())
    }

    async fn run(mut self, mut commands: mpsc::Receiver<Command>) {
        for lane in Lane::ALL {
            self.start_next(lane).await;
        }
        while let Some(command) = commands.recv().await {
            match command {
                Command::Enqueue { params, reply } => {
                    let _ = reply.send(self.enqueue(params).await);
                }
                Command::Progress { id, percent } => {
                    if self.running.contains_key(&id) {
                        self.set_state(
                            id,
                            JobState::Running {
                                percent: Some(percent),
                            },
                        )
                        .await;
                    }
                }
                Command::Finished { id, result } => self.finished(id, result).await,
                Command::Cancel { id, reply } => {
                    let _ = reply.send(self.cancel(id).await);
                }
                Command::List { reply } => {
                    let _ = reply.send(self.jobs.values().map(|e| e.job.clone()).collect());
                }
                Command::Shutdown { done } => {
                    self.stop().await;
                    let _ = done.send(());
                    return;
                }
            }
        }
    }

    async fn enqueue(&mut self, params: JobParams) -> anyhow::Result<JobId> {
        let id = store::insert(&self.db, serde_json::to_string(&params)?).await?;
        let lane = params.lane();
        let job = Job {
            id,
            kind: params.kind(),
            state: JobState::Queued,
        };
        self.broadcast(&job).await;
        self.jobs.insert(
            id,
            Entry {
                params: Some(params),
                job,
            },
        );
        self.queues.entry(lane).or_default().push_back(id);
        self.start_next(lane).await;
        Ok(id)
    }

    /// Starts queued jobs in `lane`, oldest first, while it is under its cap.
    async fn start_next(&mut self, lane: Lane) {
        while self.running.values().filter(|r| r.lane == lane).count() < lane.cap() {
            let Some(id) = self.queues.get_mut(&lane).and_then(VecDeque::pop_front) else {
                return;
            };
            let Some(params) = self.jobs.get(&id).and_then(|e| e.params.clone()) else {
                continue;
            };
            if let Err(error) = store::set_state(&self.db, id, StoredState::Running, None).await {
                tracing::error!(?error, job = id.0, "storing a job's start");
            }
            self.set_state(id, JobState::Running { percent: None })
                .await;
            let (cancel, cancelled) = watch::channel(false);
            let mut ctx = JobContext {
                progress: Progress {
                    id,
                    commands: self.commands.clone(),
                    last: AtomicU8::new(NO_PERCENT),
                },
                slot: Slot {
                    lane,
                    tool_path: self.tool_path.clone(),
                    cancel: cancelled,
                },
                env: self.env.clone(),
                usdb: self.usdb.clone(),
            };
            let commands = self.commands.clone();
            let task = tokio::spawn(async move {
                let result = params.run(&mut ctx).await;
                let _ = commands.send(Command::Finished { id, result }).await;
            });
            self.running.insert(id, Running { lane, cancel, task });
        }
    }

    async fn finished(&mut self, id: JobId, result: Result<(), UserMessage>) {
        let Some(running) = self.running.remove(&id) else {
            return;
        };
        let (stored, state) = match result {
            Ok(()) => (StoredState::Done, JobState::Done),
            Err(reason) => (StoredState::Failed, JobState::Failed { reason }),
        };
        let reason = match &state {
            JobState::Failed { reason } => Some(reason),
            _ => None,
        };
        if let Err(error) = store::set_state(&self.db, id, stored, reason).await {
            tracing::error!(?error, job = id.0, "storing a job's end");
        }
        self.set_state(id, state).await;
        self.start_next(running.lane).await;
    }

    async fn cancel(&mut self, id: JobId) -> bool {
        if let Some(running) = self.running.get(&id) {
            // The job ends with `JobCancelled` once its child is gone.
            let _ = running.cancel.send(true);
            return true;
        }
        let queued = self
            .queues
            .values_mut()
            .find_map(|queue| {
                let at = queue.iter().position(|q| *q == id)?;
                queue.remove(at)
            })
            .is_some();
        if queued {
            let reason = UserMessage::JobCancelled;
            if let Err(error) =
                store::set_state(&self.db, id, StoredState::Failed, Some(&reason)).await
            {
                tracing::error!(?error, job = id.0, "storing a job's cancellation");
            }
            self.set_state(id, JobState::Failed { reason }).await;
        }
        queued
    }

    /// Cancels every running job and waits for it to end, recording nothing:
    /// their rows stay `running` for the next start's restart rules.
    async fn stop(&mut self) {
        let running: Vec<Running> = self.running.drain().map(|(_, r)| r).collect();
        for job in &running {
            let _ = job.cancel.send(true);
        }
        for mut job in running {
            if tokio::time::timeout(STOP_WAIT, &mut job.task)
                .await
                .is_err()
            {
                job.task.abort();
                let _ = job.task.await;
            }
        }
    }

    async fn set_state(&mut self, id: JobId, state: JobState) {
        let Some(entry) = self.jobs.get_mut(&id) else {
            return;
        };
        entry.job.state = state;
        let job = entry.job.clone();
        self.broadcast(&job).await;
        if matches!(job.state, JobState::Done | JobState::Failed { .. }) {
            let topics = topics_on_end(job.kind);
            if !topics.is_empty() {
                self.live.changed(topics).await;
            }
        }
    }

    async fn broadcast(&self, job: &Job) {
        self.live
            .send_all(ServerMessage::JobChanged { job: job.clone() })
            .await;
    }
}

/// What a job of `kind` changes for browsers once it has ended (after its
/// `JobChanged`), so a status read then sees the end: the USDB mirror's
/// status says whether its run failed.
fn topics_on_end(kind: JobKind) -> Vec<ChangeTopic> {
    match kind {
        JobKind::UsdbMirrorRefetch | JobKind::UsdbMirrorUpdate => vec![ChangeTopic::UsdbMirror],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lanes_have_the_spec_caps() {
        assert_eq!(Lane::Downloads.cap(), 2);
        assert_eq!(Lane::Ffmpeg.cap(), 2);
        assert_eq!(Lane::PitchTrack.cap(), 1);
        assert_eq!(Lane::UsdbMirror.cap(), 1);
        assert!(Lane::PitchTrack.low_priority());
        assert!(!Lane::Downloads.low_priority() && !Lane::Ffmpeg.low_priority());
        assert!(!Lane::UsdbMirror.low_priority());
    }

    #[test]
    fn stored_parameters_name_their_kind() {
        let params = JobParams::Test(TestJob {
            lane: Lane::Ffmpeg,
            steps: 2,
            step_ms: 0,
            exit_code: 0,
            marker_dir: None,
            fails_after_restart: false,
        });
        let json = serde_json::to_string(&params).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"test","lane":"ffmpeg","steps":2,"stepMs":0,"exitCode":0,"markerDir":null,"failsAfterRestart":false}"#
        );
        assert_eq!(serde_json::from_str::<JobParams>(&json).unwrap(), params);
    }
}
