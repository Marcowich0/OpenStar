//! The owner's pre-release check (`just corpus <path>`, `openstar corpus
//! <path>`): every Song text a scan would read under a Library is parsed by
//! the Library's parser and written back with no edits, in memory, and the
//! bytes must come back identical.
//!
//! Nothing under the Library is ever written, moved or created: files are
//! only listed and read. A panic on one file is caught and reported, and the
//! run carries on with the next file.

use std::collections::BTreeMap;
use std::fmt;
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;

use openstar_protocol::library::{FileProblem, ProblemReason};

use super::scan;
use crate::txt::{self, TxtFile};

/// What a run found, one entry per Song text, in path order.
#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub files: Vec<FileReport>,
}

/// One Song text and what happened to it.
#[derive(Debug, Clone, PartialEq)]
pub struct FileReport {
    /// Relative to the Library, `/` between segments.
    pub path: String,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// Parsed and written back byte for byte.
    RoundTrip {
        /// The encoding it was read with (`TxtEncoding::name`).
        encoding: &'static str,
        /// How many warnings the parser gave.
        warnings: usize,
    },
    /// The Library rejects it (or cannot read it). Not a failure of the run.
    Rejected { reason: ProblemReason },
    /// The parser or the writer panicked (or the writer refused to write).
    Crashed { message: String },
    /// Written back with no edits, the bytes differ from the file's.
    Mismatch {
        /// The first line (1-based, in the file) where the bytes differ; one
        /// past the last line when the written bytes only add to the end.
        line: usize,
    },
}

impl Report {
    /// How many Song texts were read (every outcome).
    pub fn songs_read(&self) -> usize {
        self.files.len()
    }

    pub fn rejects(&self) -> usize {
        self.count(|o| matches!(o, Outcome::Rejected { .. }))
    }

    pub fn crashes(&self) -> usize {
        self.count(|o| matches!(o, Outcome::Crashed { .. }))
    }

    pub fn mismatches(&self) -> usize {
        self.count(|o| matches!(o, Outcome::Mismatch { .. }))
    }

    /// How many warnings the parser gave over every round-tripped file.
    pub fn warnings(&self) -> usize {
        self.files
            .iter()
            .map(|f| match f.outcome {
                Outcome::RoundTrip { warnings, .. } => warnings,
                _ => 0,
            })
            .sum()
    }

    /// No crash and no mismatch; rejects alone never fail a run.
    pub fn passed(&self) -> bool {
        self.crashes() == 0 && self.mismatches() == 0
    }

    fn count(&self, matches: impl Fn(&Outcome) -> bool) -> usize {
        self.files.iter().filter(|f| matches(&f.outcome)).count()
    }
}

impl fmt::Display for Report {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let section = |f: &mut fmt::Formatter<'_>,
                       title: &str,
                       line: &dyn Fn(&Outcome) -> Option<String>|
         -> fmt::Result {
            let lines: Vec<_> = self
                .files
                .iter()
                .filter_map(|file| line(&file.outcome).map(|l| format!("  {}: {l}", file.path)))
                .collect();
            if !lines.is_empty() {
                writeln!(f, "{title} ({}):", lines.len())?;
                for line in lines {
                    writeln!(f, "{line}")?;
                }
                writeln!(f)?;
            }
            Ok(())
        };
        section(f, "Crashes", &|o| match o {
            Outcome::Crashed { message } => Some(message.clone()),
            _ => None,
        })?;
        section(f, "Mismatches", &|o| match o {
            Outcome::Mismatch { line } => Some(format!("first differs at line {line}")),
            _ => None,
        })?;
        section(f, "Rejects", &|o| match o {
            Outcome::Rejected { reason } => {
                Some(serde_json::to_string(reason).unwrap_or_else(|_| format!("{reason:?}")))
            }
            _ => None,
        })?;

        let mut encodings = BTreeMap::new();
        for file in &self.files {
            if let Outcome::RoundTrip { encoding, .. } = file.outcome {
                *encodings.entry(encoding).or_insert(0usize) += 1;
            }
        }
        let encodings: Vec<_> = encodings
            .into_iter()
            .map(|(name, n)| format!("{name} {n}"))
            .collect();
        writeln!(
            f,
            "Songs read: {}, rejects: {}, crashes: {}, mismatches: {}",
            self.songs_read(),
            self.rejects(),
            self.crashes(),
            self.mismatches()
        )?;
        writeln!(
            f,
            "Warnings: {}; encodings: {}",
            self.warnings(),
            if encodings.is_empty() {
                "none".to_owned()
            } else {
                encodings.join(", ")
            }
        )?;
        write!(f, "{}", if self.passed() { "PASSED" } else { "FAILED" })
    }
}

/// Checks every Song text under the Library at `root` with the Library's
/// parser and writer. Fails only when the Library cannot be listed.
pub fn run(root: &Path) -> anyhow::Result<Report> {
    run_with(root, |file| {
        txt::write(file, &[])
            .unwrap_or_else(|error| panic!("the writer refused to write it unedited: {error:?}"))
            .bytes
    })
}

/// [`run`] with another writer in place of the Library's unedited write:
/// the seam through which tests provoke a crash or a mismatch.
pub fn run_with(root: &Path, write: impl Fn(&TxtFile) -> Vec<u8>) -> anyhow::Result<Report> {
    let files = scan::txt_files(root, "")?
        .into_iter()
        .map(|path| {
            let outcome = check(root, &path, &write);
            FileReport { path, outcome }
        })
        .collect();
    Ok(Report { files })
}

fn check(root: &Path, path: &str, write: &impl Fn(&TxtFile) -> Vec<u8>) -> Outcome {
    let Ok(bytes) = std::fs::read(root.join(path)) else {
        return Outcome::Rejected {
            reason: ProblemReason::File(FileProblem::UnreadableFile),
        };
    };
    // The folder holding the file, as the scan passes it.
    let folder_name = Path::new(path)
        .parent()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        txt::parse(&bytes, &folder_name).map(|file| {
            let written = write(&file);
            (file, written)
        })
    }));
    match result {
        Err(payload) => Outcome::Crashed {
            message: panic_message(payload.as_ref()),
        },
        Ok(Err(rejection)) => Outcome::Rejected {
            reason: ProblemReason::Rejection(rejection),
        },
        Ok(Ok((file, written))) => match first_difference(&bytes, &written) {
            None => Outcome::RoundTrip {
                encoding: file.encoding.name(),
                warnings: file.warnings.len(),
            },
            Some(offset) => Outcome::Mismatch {
                line: line_at(&file, offset),
            },
        },
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    let text = payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic without a message".to_owned());
    format!("panicked: {text}")
}

fn first_difference(a: &[u8], b: &[u8]) -> Option<usize> {
    match a.iter().zip(b).position(|(x, y)| x != y) {
        Some(offset) => Some(offset),
        None if a.len() == b.len() => None,
        None => Some(a.len().min(b.len())),
    }
}

/// The 1-based line of the parsed file holding byte `offset` (one past the
/// last line when `offset` is the end of the file).
fn line_at(file: &TxtFile, offset: usize) -> usize {
    let mut end = 0;
    for (index, line) in file.lines.iter().enumerate() {
        end += line.bytes.len() + line.ending.as_bytes().len();
        if offset < end {
            return index + 1;
        }
    }
    file.lines.len() + 1
}
