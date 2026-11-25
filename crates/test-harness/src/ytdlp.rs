//! A `yt-dlp` stub for the front of `PATH` (the script is `yt-dlp-stub.sh`).

use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

/// The stub script, installed as `yt-dlp`.
pub const STUB_SCRIPT: &str = include_str!("yt-dlp-stub.sh");

/// What a scripted call does instead of succeeding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum YtDlpStubBehaviour {
    /// Prints `message` on stderr and exits with `exit_code`.
    Fail { exit_code: u8, message: String },
    /// Never exits (until killed).
    Hang,
}

/// A folder holding the `yt-dlp` stub, for the front of `PATH`. The folder is
/// temporary and removed when this value is dropped.
pub struct YtDlpStub {
    dir: TempDir,
}

impl YtDlpStub {
    /// Installs the stub in a new temporary folder.
    pub fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("openstar-ytdlp-stub-")
            .tempdir()
            .expect("creating the stub's folder");
        Self::install(dir.path()).expect("installing the yt-dlp stub");
        Self { dir }
    }

    /// Writes the stub as `yt-dlp` into `dir` (created if missing). Used by
    /// the standalone `openstar-harness ytdlp-stub` for `just e2e`.
    pub fn install(dir: &Path) -> std::io::Result<PathBuf> {
        fs::create_dir_all(dir.join("calls"))?;
        let path = dir.join("yt-dlp");
        crate::write_executable(&path, STUB_SCRIPT)?;
        Ok(path)
    }

    /// The folder to put first on `PATH`.
    pub fn dir(&self) -> &Path {
        self.dir.path()
    }

    /// The process's `PATH` with the stub's folder in front.
    pub fn path_env(&self) -> OsString {
        let rest = std::env::var_os("PATH").unwrap_or_default();
        let parts = std::iter::once(self.dir().to_path_buf()).chain(std::env::split_paths(&rest));
        std::env::join_paths(parts).expect("PATH entries without ':'")
    }

    /// Makes the next `times` calls behave as `behaviour`. Scripts queue in order.
    pub fn script(&self, behaviour: YtDlpStubBehaviour, times: usize) {
        let line = match &behaviour {
            YtDlpStubBehaviour::Fail { exit_code, message } => {
                format!("fail {exit_code} {}", message.replace('\n', " "))
            }
            YtDlpStubBehaviour::Hang => "hang".to_owned(),
        };
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir().join("behaviours"))
            .expect("opening the stub's behaviours");
        for _ in 0..times {
            writeln!(file, "{line}").expect("scripting the stub");
        }
    }

    /// The arguments of every call so far, in call order.
    pub fn calls(&self) -> Vec<Vec<String>> {
        read_calls(self.dir())
    }
}

impl Default for YtDlpStub {
    fn default() -> Self {
        Self::new()
    }
}

/// The recorded calls of the stub installed in `dir`.
pub fn read_calls(dir: &Path) -> Vec<Vec<String>> {
    let Ok(entries) = fs::read_dir(dir.join("calls")) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "args"))
        .collect();
    files.sort();
    files
        .iter()
        .map(|path| {
            let bytes = fs::read(path).expect("reading a recorded call");
            // Every argument ends with a NUL byte; no arguments is an empty file.
            match bytes.strip_suffix(&[0]) {
                None => Vec::new(),
                Some(args) => args
                    .split(|&b| b == 0)
                    .map(|arg| String::from_utf8_lossy(arg).into_owned())
                    .collect(),
            }
        })
        .collect()
}
