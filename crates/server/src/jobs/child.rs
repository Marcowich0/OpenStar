//! The one helper that starts ffprobe, ffmpeg, yt-dlp (and the test job's
//! `sh`) as child processes. Nothing links those tools in.
//!
//! A [`Slot`] is a job's place in its lane: the runner hands one to a job only
//! when the lane is under its cap, and a child can only be started through a
//! slot, so the lane's cap holds for child processes too. The child runs with
//! the settings' `PATH`, at low CPU priority in a low-priority lane, and is
//! killed (and reaped) as soon as its job is cancelled.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::process::Stdio;

use openstar_protocol::UserMessage;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::watch;

use super::Lane;

/// The niceness a low-priority lane's children run at.
const LOW_PRIORITY_NICENESS: &str = "19";

/// How many of a failed child's last stderr lines go to the log.
const STDERR_TAIL: usize = 20;

/// A running job's place in its lane, handed to it by the runner.
pub struct Slot {
    pub(super) lane: Lane,
    /// `PATH` from the settings; `None` keeps the process's own.
    pub(super) tool_path: Option<String>,
    pub(super) cancel: watch::Receiver<bool>,
}

impl Slot {
    /// A slot outside the lanes, for the Library scan's ffprobe calls. The
    /// scan runs one at a time and probes one file at a time, so it needs no
    /// cap of its own; `cancel` kills the running child once it turns true.
    pub(crate) fn outside_lanes(tool_path: Option<String>, cancel: watch::Receiver<bool>) -> Self {
        Self {
            lane: Lane::Ffmpeg,
            tool_path,
            cancel,
        }
    }

    /// A child process running `program`, found on the settings' `PATH`.
    pub fn command(&self, program: &str) -> ToolCommand<'_> {
        ToolCommand {
            slot: self,
            program: program.to_owned(),
            args: Vec::new(),
        }
    }

    /// Completes once the job is cancelled (or the server stops), for a job
    /// that also does work outside its child processes.
    pub async fn cancelled(&self) {
        let mut cancel = self.cancel.clone();
        if cancel.wait_for(|cancelled| *cancelled).await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// A child process to start; see [`Slot::command`].
pub struct ToolCommand<'a> {
    slot: &'a Slot,
    program: String,
    args: Vec<OsString>,
}

impl ToolCommand<'_> {
    #[must_use]
    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Runs the child to its end, handing each line it writes to stdout to
    /// `on_line`. Fails with [`UserMessage::JobCancelled`] when the job is
    /// cancelled (the child is killed first), [`UserMessage::ToolNotFound`]
    /// when the program is missing and [`UserMessage::ToolFailed`] when it
    /// exits unsuccessfully.
    pub async fn run_lines(self, mut on_line: impl FnMut(&str)) -> Result<(), UserMessage> {
        let low_priority = self.slot.lane.low_priority();
        let mut command = if low_priority {
            let mut nice = Command::new("nice");
            nice.arg("-n").arg(LOW_PRIORITY_NICENESS).arg(&self.program);
            nice
        } else {
            Command::new(&self.program)
        };
        command
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(path) = &self.slot.tool_path {
            command.env("PATH", path);
        }
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                UserMessage::ToolNotFound {
                    tool: self.program.clone(),
                }
            } else {
                tracing::error!(%error, program = self.program, "starting a child process");
                UserMessage::ServerError
            }
        })?;

        let stderr = child.stderr.take().map(|stderr| {
            tokio::spawn(async move {
                let mut tail = VecDeque::with_capacity(STDERR_TAIL);
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if tail.len() == STDERR_TAIL {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
                tail
            })
        });
        let mut stdout = child.stdout.take().map(|out| BufReader::new(out).lines());

        let cancelled = self.slot.cancelled();
        tokio::pin!(cancelled);
        let status = loop {
            tokio::select! {
                biased;
                () = &mut cancelled => {
                    // Kills and reaps the child, so it is gone when the job ends.
                    if let Err(error) = child.kill().await {
                        tracing::warn!(%error, program = self.program, "killing a cancelled child process");
                    }
                    return Err(UserMessage::JobCancelled);
                }
                line = next_line(&mut stdout), if stdout.is_some() => match line {
                    Some(line) => {
                        on_line(&line);
                        // Lines read from a buffer cost the task no budget, so
                        // a chatty child would otherwise hold a worker thread
                        // (and delay the relay) until its pipe runs dry.
                        tokio::task::coop::consume_budget().await;
                    }
                    None => stdout = None,
                },
                status = child.wait(), if stdout.is_none() => break status,
            }
        };
        let status = status.map_err(|error| {
            tracing::error!(%error, program = self.program, "waiting for a child process");
            UserMessage::ServerError
        })?;
        if status.success() {
            return Ok(());
        }
        let tail = match stderr {
            Some(task) => task.await.unwrap_or_default(),
            None => VecDeque::new(),
        };
        tracing::warn!(
            program = self.program,
            %status,
            stderr = %Vec::from(tail).join("\n"),
            "a child process failed"
        );
        // `nice` exits 127 when it cannot find the program.
        if low_priority && status.code() == Some(127) {
            return Err(UserMessage::ToolNotFound { tool: self.program });
        }
        Err(UserMessage::ToolFailed {
            tool: self.program,
            exit_code: status.code(),
        })
    }
}

/// The next stdout line, or `None` once stdout is closed (or unreadable).
async fn next_line(
    stdout: &mut Option<tokio::io::Lines<BufReader<tokio::process::ChildStdout>>>,
) -> Option<String> {
    let lines = stdout.as_mut()?;
    match lines.next_line().await {
        Ok(line) => line,
        Err(error) => {
            tracing::warn!(%error, "reading a child process's output");
            None
        }
    }
}
