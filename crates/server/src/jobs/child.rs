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
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
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

    /// Whether the job has been cancelled (or the server is stopping).
    pub fn is_cancelled(&self) -> bool {
        *self.cancel.borrow()
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

/// Why a child run with [`ToolCommand::run_lines_with_stderr`] failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolFailure {
    /// What [`ToolCommand::run_lines`] would have failed with.
    pub message: UserMessage,
    /// The last lines the child wrote to stderr (at most 20); empty when it
    /// did not run to its end (cancelled, not found).
    pub stderr: Vec<String>,
}

impl From<UserMessage> for ToolFailure {
    fn from(message: UserMessage) -> Self {
        Self {
            message,
            stderr: Vec::new(),
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
    pub async fn run_lines(self, on_line: impl FnMut(&str)) -> Result<(), UserMessage> {
        self.run_lines_with_stderr(on_line)
            .await
            .map_err(|failure| failure.message)
    }

    /// [`ToolCommand::run_lines`], also handing back the last lines the child
    /// wrote to stderr when it failed (yt-dlp's `HTTP Error 403`).
    pub async fn run_lines_with_stderr(
        self,
        mut on_line: impl FnMut(&str),
    ) -> Result<(), ToolFailure> {
        self.run(
            |stdout| Output::Lines(BufReader::new(stdout).lines(), String::new()),
            |chunk| {
                if let Chunk::Line(line) = chunk {
                    on_line(line);
                }
            },
        )
        .await
    }

    /// Runs the child to its end, handing what it writes to stdout to
    /// `on_bytes` as it arrives, in chunks of any size (raw PCM on a pipe).
    /// Fails like [`ToolCommand::run_lines`].
    pub async fn run_bytes(self, mut on_bytes: impl FnMut(&[u8])) -> Result<(), UserMessage> {
        self.run(
            |stdout| Output::Bytes(stdout, vec![0; BYTES_CHUNK], 0),
            |chunk| {
                if let Chunk::Bytes(bytes) = chunk {
                    on_bytes(bytes);
                }
            },
        )
        .await
        .map_err(|failure| failure.message)
    }

    async fn run(
        self,
        output: impl FnOnce(tokio::process::ChildStdout) -> Output,
        mut on_chunk: impl FnMut(Chunk<'_>),
    ) -> Result<(), ToolFailure> {
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
        let mut stdout = child.stdout.take().map(output);

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
                    return Err(UserMessage::JobCancelled.into());
                }
                more = next_chunk(&mut stdout), if stdout.is_some() => {
                    if more {
                        if let Some(output) = &stdout {
                            on_chunk(output.chunk());
                        }
                        // Reads from a buffer cost the task no budget, so
                        // a chatty child would otherwise hold a worker thread
                        // (and delay the relay) until its pipe runs dry.
                        tokio::task::coop::consume_budget().await;
                    } else {
                        stdout = None;
                    }
                }
                status = child.wait(), if stdout.is_none() => break status,
            }
        };
        let status = status.map_err(|error| {
            tracing::error!(%error, program = self.program, "waiting for a child process");
            ToolFailure::from(UserMessage::ServerError)
        })?;
        if status.success() {
            return Ok(());
        }
        let tail = match stderr {
            Some(task) => Vec::from(task.await.unwrap_or_default()),
            None => Vec::new(),
        };
        tracing::warn!(
            program = self.program,
            %status,
            stderr = %tail.join("\n"),
            "a child process failed"
        );
        // `nice` exits 127 when it cannot find the program.
        let message = if low_priority && status.code() == Some(127) {
            UserMessage::ToolNotFound { tool: self.program }
        } else {
            UserMessage::ToolFailed {
                tool: self.program,
                exit_code: status.code(),
            }
        };
        Err(ToolFailure {
            message,
            stderr: tail,
        })
    }
}

/// How many bytes [`ToolCommand::run_bytes`] reads at most per chunk.
const BYTES_CHUNK: usize = 64 * 1024;

/// A child's stdout as a job reads it.
enum Output {
    /// Lines; holds the last line read.
    Lines(
        tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
        String,
    ),
    /// Raw bytes; holds the buffer and how much of it the last read filled.
    Bytes(tokio::process::ChildStdout, Vec<u8>, usize),
}

/// What the last read gave.
enum Chunk<'a> {
    Line(&'a str),
    Bytes(&'a [u8]),
}

impl Output {
    fn chunk(&self) -> Chunk<'_> {
        match self {
            Self::Lines(_, line) => Chunk::Line(line),
            Self::Bytes(_, buffer, filled) => Chunk::Bytes(&buffer[..*filled]),
        }
    }
}

/// Reads the next line or chunk of stdout into `stdout`; false once stdout
/// is closed (or unreadable).
async fn next_chunk(stdout: &mut Option<Output>) -> bool {
    let Some(output) = stdout.as_mut() else {
        return false;
    };
    let read = match output {
        Output::Lines(lines, last) => lines.next_line().await.map(|line| match line {
            Some(line) => {
                *last = line;
                true
            }
            None => false,
        }),
        Output::Bytes(out, buffer, filled) => out.read(buffer).await.map(|n| {
            *filled = n;
            n > 0
        }),
    };
    read.unwrap_or_else(|error| {
        tracing::warn!(%error, "reading a child process's output");
        false
    })
}
