//! Writing a script a test then runs.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

/// Writes `contents` to `path` as an executable file.
///
/// The file is written by a child process, never by this one. A file this
/// process has open for writing is inherited by every child another thread
/// forks at that moment, and until that child execs, running the file fails
/// with "Text file busy". Tests run in threads and start children all the
/// time, so a plain `fs::write` followed by running the file fails now and
/// then.
pub fn write_executable(path: &Path, contents: &str) -> std::io::Result<()> {
    let source = path.with_extension("source");
    fs::write(&source, contents)?;
    let copied = Command::new("cp").arg(&source).arg(path).status()?;
    if !copied.success() {
        return Err(std::io::Error::other(format!(
            "copying {} failed",
            path.display()
        )));
    }
    fs::remove_file(&source)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}
