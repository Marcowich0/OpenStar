//! Which yt-dlp the server runs. Every yt-dlp invocation in the server asks
//! [`YtDlp::program`] first: OpenStar's own copy in `/appdata/bin` (kept up
//! to date by the self-update in [`update`]) when it is there, matches the
//! checksum recorded beside it (`yt-dlp.sha256`) and runs, otherwise the copy
//! pinned in the image, found on the settings' `PATH`.

pub mod update;

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use tokio::sync::watch;

use crate::jobs::Slot;

/// The image's copy, found on `PATH`.
pub const IMAGE_PROGRAM: &str = "yt-dlp";

/// OpenStar's own copy, below the appdata folder.
pub const OWN_COPY: &str = "bin/yt-dlp";

/// The own copy's SHA-256 as the self-update installed it (lowercase hex),
/// in a file beside it: `yt-dlp.sha256`.
pub fn checksum_file(own_copy: &Path) -> PathBuf {
    own_copy.with_file_name(format!(
        "{}.sha256",
        own_copy.file_name().unwrap_or_default().to_string_lossy()
    ))
}

/// The SHA-256 of `bytes` in lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

/// The SHA-256 of the file at `path` in lowercase hex, read in pieces.
/// Blocking: call it on a blocking thread.
pub fn file_sha256_hex(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(hex(&hasher.finalize()));
        }
        hasher.update(&buffer[..read]);
    }
}

/// Records the file at `own_copy`'s checksum beside it, as the self-update
/// does after installing it. For tests that put a copy in place by hand.
pub fn record_checksum(own_copy: &Path) -> std::io::Result<()> {
    let sum = file_sha256_hex(own_copy)?;
    std::fs::write(checksum_file(own_copy), format!("{sum}\n"))
}

/// The checksum recorded for `own_copy`, if there is a readable one.
fn recorded_checksum(own_copy: &Path) -> Option<String> {
    let text = std::fs::read_to_string(checksum_file(own_copy)).ok()?;
    let sum = text.split_whitespace().next()?.to_ascii_lowercase();
    (sum.len() == 64 && sum.bytes().all(|b| b.is_ascii_hexdigit())).then_some(sum)
}

/// Whether the file at `own_copy` hashes to the checksum recorded beside it.
/// Blocking.
fn matches_recorded(own_copy: &Path) -> bool {
    recorded_checksum(own_copy)
        .is_some_and(|sum| file_sha256_hex(own_copy).is_ok_and(|actual| actual == sum))
}

/// How long `--version` may take before the own copy counts as not running.
const VERSION_CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// The resolver. Cheap to clone; clones share what they found out.
#[derive(Clone)]
pub struct YtDlp {
    inner: Arc<Inner>,
}

struct Inner {
    own_copy: PathBuf,
    /// `false` when the self-update is off: the own copy is never run.
    use_own_copy: bool,
    tool_path: Option<String>,
    /// Whether the own copy matched its checksum and ran, for the file as it
    /// was then (its length and modification time, and the checksum
    /// recorded for it): a new copy is checked again.
    checked: Mutex<Option<(Stamp, bool)>>,
}

type Stamp = (u64, Option<SystemTime>, Option<String>);

impl YtDlp {
    /// A resolver that prefers the own copy below `appdata_dir`.
    pub fn new(appdata_dir: &Path, tool_path: Option<String>) -> Self {
        Self::with_own_copy(appdata_dir, tool_path, true)
    }

    /// A resolver that always answers the image's copy
    /// (`OPENSTAR_YTDLP_AUTOUPDATE=false`).
    pub fn image_only(appdata_dir: &Path, tool_path: Option<String>) -> Self {
        Self::with_own_copy(appdata_dir, tool_path, false)
    }

    fn with_own_copy(appdata_dir: &Path, tool_path: Option<String>, use_own_copy: bool) -> Self {
        Self {
            inner: Arc::new(Inner {
                use_own_copy,
                own_copy: appdata_dir.join(OWN_COPY),
                tool_path,
                checked: Mutex::new(None),
            }),
        }
    }

    /// Where OpenStar's own copy lives (`/appdata/bin/yt-dlp`), for the
    /// self-update to write.
    pub fn own_copy(&self) -> &Path {
        &self.inner.own_copy
    }

    /// The `PATH` yt-dlp runs with.
    pub fn tool_path(&self) -> Option<String> {
        self.inner.tool_path.clone()
    }

    /// The program to run: the own copy when it exists, matches the
    /// checksum recorded beside it and `--version` succeeds, else
    /// [`IMAGE_PROGRAM`]. A copy that fails its checksum is never run.
    pub async fn program(&self) -> String {
        if !self.inner.use_own_copy {
            return IMAGE_PROGRAM.to_owned();
        }
        let own = &self.inner.own_copy;
        let Ok(metadata) = tokio::fs::metadata(own).await else {
            return IMAGE_PROGRAM.to_owned();
        };
        let recorded = {
            let own = own.clone();
            tokio::task::spawn_blocking(move || recorded_checksum(&own))
                .await
                .ok()
                .flatten()
        };
        let stamp = (metadata.len(), metadata.modified().ok(), recorded);
        let known = self
            .inner
            .checked
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let runs = match known {
            Some((checked, runs)) if checked == stamp => runs,
            _ => {
                let matches = {
                    let own = own.clone();
                    tokio::task::spawn_blocking(move || matches_recorded(&own))
                        .await
                        .unwrap_or(false)
                };
                let runs = if !matches {
                    tracing::warn!(
                        path = %own.display(),
                        "OpenStar's own yt-dlp fails its checksum; using the image's copy"
                    );
                    false
                } else if runs(&self.inner.tool_path, own).await {
                    true
                } else {
                    tracing::warn!(
                        path = %own.display(),
                        "OpenStar's own yt-dlp does not run; using the image's copy"
                    );
                    false
                };
                *self
                    .inner
                    .checked
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner) = Some((stamp, runs));
                runs
            }
        };
        if runs {
            own.to_string_lossy().into_owned()
        } else {
            IMAGE_PROGRAM.to_owned()
        }
    }
}

/// Whether `program --version` succeeds within [`VERSION_CHECK_TIMEOUT`].
async fn runs(tool_path: &Option<String>, program: &Path) -> bool {
    let (_never, cancel) = watch::channel(false);
    let slot = Slot::outside_lanes(tool_path.clone(), cancel);
    let check = slot
        .command(&program.to_string_lossy())
        .arg("--version")
        .run_lines(|_| {});
    matches!(
        tokio::time::timeout(VERSION_CHECK_TIMEOUT, check).await,
        Ok(Ok(()))
    )
}
