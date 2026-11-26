//! Which yt-dlp the server runs. Every yt-dlp invocation in the server asks
//! [`YtDlp::program`] first: OpenStar's own copy in `/appdata/bin` (kept up
//! to date by the self-update, #198) when it is there and runs, otherwise
//! the copy pinned in the image, found on the settings' `PATH`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use tokio::sync::watch;

use crate::jobs::Slot;

/// The image's copy, found on `PATH`.
pub const IMAGE_PROGRAM: &str = "yt-dlp";

/// OpenStar's own copy, below the appdata folder.
pub const OWN_COPY: &str = "bin/yt-dlp";

/// How long `--version` may take before the own copy counts as not running.
const VERSION_CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// The resolver. Cheap to clone; clones share what they found out.
#[derive(Clone)]
pub struct YtDlp {
    inner: Arc<Inner>,
}

struct Inner {
    own_copy: PathBuf,
    tool_path: Option<String>,
    /// Whether the own copy ran, for the file as it was then (its length
    /// and modification time): a new copy is checked again.
    checked: Mutex<Option<(Stamp, bool)>>,
}

type Stamp = (u64, Option<SystemTime>);

impl YtDlp {
    pub fn new(appdata_dir: &Path, tool_path: Option<String>) -> Self {
        Self {
            inner: Arc::new(Inner {
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

    /// The program to run: the own copy when it exists and `--version`
    /// succeeds, else [`IMAGE_PROGRAM`].
    pub async fn program(&self) -> String {
        let own = &self.inner.own_copy;
        let Ok(metadata) = tokio::fs::metadata(own).await else {
            return IMAGE_PROGRAM.to_owned();
        };
        let stamp = (metadata.len(), metadata.modified().ok());
        let known = *self
            .inner
            .checked
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let runs = match known {
            Some((checked, runs)) if checked == stamp => runs,
            _ => {
                let runs = self.runs(own).await;
                if !runs {
                    tracing::warn!(
                        path = %own.display(),
                        "OpenStar's own yt-dlp does not run; using the image's copy"
                    );
                }
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

    async fn runs(&self, program: &Path) -> bool {
        let (_never, cancel) = watch::channel(false);
        let slot = Slot::outside_lanes(self.inner.tool_path.clone(), cancel);
        let check = slot
            .command(&program.to_string_lossy())
            .arg("--version")
            .run_lines(|_| {});
        matches!(
            tokio::time::timeout(VERSION_CHECK_TIMEOUT, check).await,
            Ok(Ok(()))
        )
    }
}
