//! yt-dlp's self-update: OpenStar keeps its own copy in `/appdata/bin`,
//! checked against yt-dlp's latest official release at start and daily.
//!
//! One check:
//!
//! 1. `GET <releases>/latest` follows GitHub's redirect to
//!    `<releases>/tag/<tag>`, which names the latest release.
//! 2. `GET <releases>/download/<tag>/SHA2-256SUMS` gives the published
//!    SHA-256 of `yt-dlp_linux`.
//! 3. When the own copy already matches it (and its recorded checksum), the
//!    check ends there.
//! 4. Else `yt-dlp_linux` is downloaded beside the own copy
//!    (`yt-dlp.download`), hashed as it arrives, and dropped when its SHA-256
//!    is not the published one, before it is ever run.
//! 5. A verified download must pass `--version`; then its checksum is
//!    recorded (`yt-dlp.sha256`) and it is renamed over the own copy. A
//!    rename swaps the file in one step: a yt-dlp already running keeps the
//!    file it started with, and a new run gets the old copy or the new one,
//!    never a half-written file.
//!
//! A failed check is logged and changes nothing; the next one runs as
//! scheduled. The resolver ([`super::YtDlp::program`]) falls back to the
//! image's copy whenever the own copy is missing, fails its checksum or does
//! not run.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, bail};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::{YtDlp, checksum_file, hex, matches_recorded, recorded_checksum, runs};

/// How often the update is checked after the check at start.
pub const DAILY: Duration = Duration::from_secs(24 * 60 * 60);

/// The binary's file name in a release.
pub const RELEASE_BINARY: &str = "yt-dlp_linux";
/// The release's published checksums.
pub const RELEASE_SUMS: &str = "SHA2-256SUMS";

/// A download larger than this is refused (yt-dlp_linux is about 35 MB).
const MAX_BINARY_BYTES: u64 = 512 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// `--version` of a fresh download is tried this many times: a child forked
/// by another thread while the file was still open for writing holds it
/// open until it execs, and running the file meanwhile fails ("Text file
/// busy").
const RUN_ATTEMPTS: u32 = 3;
const RUN_RETRY_WAIT: Duration = Duration::from_millis(200);

/// What a check did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checked {
    /// The own copy is the latest release already.
    UpToDate { version: String },
    /// The latest release was downloaded, verified and swapped in.
    Installed { version: String },
}

/// Checks and installs yt-dlp's latest release into the own copy.
#[derive(Clone)]
pub struct Updater {
    ytdlp: YtDlp,
    releases_url: String,
    http: reqwest::Client,
}

impl Updater {
    /// An updater for `ytdlp`'s own copy, from the releases at
    /// `releases_url` (`https://github.com/yt-dlp/yt-dlp/releases`, no
    /// trailing slash).
    pub fn new(ytdlp: YtDlp, releases_url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(format!("OpenStar/{}", crate::BUILD_ID))
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("building the yt-dlp update's HTTP client");
        Self {
            ytdlp,
            releases_url: releases_url.into(),
            http,
        }
    }

    /// Checks now, then every `every`, until the task is aborted. Failures
    /// are logged and never end the loop.
    pub async fn run(self, every: Duration) {
        loop {
            match self.check().await {
                Ok(Checked::UpToDate { version }) => {
                    tracing::info!(version, "OpenStar's own yt-dlp is up to date");
                }
                Ok(Checked::Installed { version }) => {
                    tracing::info!(version, "installed yt-dlp into appdata/bin");
                }
                Err(error) => {
                    tracing::warn!(
                        error = format!("{error:#}"),
                        "the yt-dlp update failed; the copy in use stays"
                    );
                }
            }
            tokio::time::sleep(every).await;
        }
    }

    /// One check, as described in the module docs.
    pub async fn check(&self) -> anyhow::Result<Checked> {
        let own = self.ytdlp.own_copy().to_path_buf();
        let download = own.with_file_name("yt-dlp.download");
        let result = self.check_into(&own, &download).await;
        if result.is_err() {
            // Whatever went wrong, no half-written or rejected file stays.
            let _ = tokio::fs::remove_file(&download).await;
        }
        result
    }

    async fn check_into(&self, own: &Path, download: &Path) -> anyhow::Result<Checked> {
        let version = self.latest_version().await?;
        let expected = self.published_checksum(&version).await?;

        let current = {
            let own = own.to_path_buf();
            tokio::task::spawn_blocking(move || {
                recorded_checksum(&own).filter(|_| matches_recorded(&own))
            })
            .await
            .ok()
            .flatten()
        };
        if current.as_deref() == Some(expected.as_str()) {
            return Ok(Checked::UpToDate { version });
        }

        let bin = own.parent().context("the own copy has no folder")?;
        tokio::fs::create_dir_all(bin)
            .await
            .with_context(|| format!("creating {}", bin.display()))?;
        let actual = self.download_binary(&version, download).await?;
        if actual != expected {
            bail!(
                "the downloaded {RELEASE_BINARY} of {version} has SHA-256 {actual}, \
                 but the release publishes {expected}: not installed"
            );
        }
        self.check_runs(download, &version).await?;
        install(own, download, &expected).await?;
        Ok(Checked::Installed { version })
    }

    /// The latest release's tag, from where `<releases>/latest` redirects.
    async fn latest_version(&self) -> anyhow::Result<String> {
        let url = format!("{}/latest", self.releases_url);
        let response = self
            .http
            .get(&url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .with_context(|| format!("asking for the latest yt-dlp release at {url}"))?;
        let path = response.url().path();
        let tag = path
            .rsplit_once("/tag/")
            .map(|(_, tag)| tag.trim_end_matches('/'))
            .filter(|tag| is_tag(tag))
            .with_context(|| format!("{url} did not lead to a release tag (it led to {path})"))?;
        Ok(tag.to_owned())
    }

    /// The SHA-256 the release publishes for [`RELEASE_BINARY`].
    async fn published_checksum(&self, version: &str) -> anyhow::Result<String> {
        let url = self.download_url(version, RELEASE_SUMS);
        let text = self
            .http
            .get(&url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .with_context(|| format!("downloading {url}"))?
            .text()
            .await
            .with_context(|| format!("downloading {url}"))?;
        published_sum(&text, RELEASE_BINARY)
            .with_context(|| format!("{url} lists no SHA-256 for {RELEASE_BINARY}"))
    }

    /// Downloads the binary to `path` (executable), returning its SHA-256.
    async fn download_binary(&self, version: &str, path: &Path) -> anyhow::Result<String> {
        let url = self.download_url(version, RELEASE_BINARY);
        let mut response = self
            .http
            .get(&url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .with_context(|| format!("downloading {url}"))?;
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o755)
            .open(path)
            .await
            .with_context(|| format!("creating {}", path.display()))?;
        let mut hasher = Sha256::new();
        let mut written: u64 = 0;
        while let Some(chunk) = response
            .chunk()
            .await
            .with_context(|| format!("downloading {url}"))?
        {
            written += chunk.len() as u64;
            if written > MAX_BINARY_BYTES {
                bail!("{url} is larger than {MAX_BINARY_BYTES} bytes");
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .with_context(|| format!("writing {}", path.display()))?;
        }
        file.sync_all()
            .await
            .with_context(|| format!("writing {}", path.display()))?;
        drop(file);
        Ok(hex(&hasher.finalize()))
    }

    async fn check_runs(&self, path: &Path, version: &str) -> anyhow::Result<()> {
        let tool_path = self.ytdlp.tool_path();
        for attempt in 1..=RUN_ATTEMPTS {
            if runs(&tool_path, path).await {
                return Ok(());
            }
            if attempt < RUN_ATTEMPTS {
                tokio::time::sleep(RUN_RETRY_WAIT).await;
            }
        }
        bail!(
            "the verified {RELEASE_BINARY} of {version} does not run (--version failed): not installed"
        )
    }

    fn download_url(&self, version: &str, file: &str) -> String {
        format!("{}/download/{version}/{file}", self.releases_url)
    }
}

/// Records `sum` and renames the verified `download` over `own`. The
/// checksum goes first: until the rename the old copy fails it and the
/// resolver uses the image's copy, never an unverified file.
async fn install(own: &Path, download: &Path, sum: &str) -> anyhow::Result<()> {
    let sums = checksum_file(own);
    let sums_download: PathBuf = sums.with_extension("sha256.download");
    tokio::fs::write(&sums_download, format!("{sum}\n"))
        .await
        .with_context(|| format!("writing {}", sums_download.display()))?;
    tokio::fs::rename(&sums_download, &sums)
        .await
        .with_context(|| format!("renaming into {}", sums.display()))?;
    tokio::fs::rename(download, own)
        .await
        .with_context(|| format!("renaming into {}", own.display()))?;
    Ok(())
}

/// A release tag such as `2026.11.20` or `2026.11.20.1`: digits and dots.
fn is_tag(tag: &str) -> bool {
    !tag.is_empty() && tag.bytes().all(|b| b.is_ascii_digit() || b == b'.')
}

/// The SHA-256 a `sha256sum`-style file gives `name` (`<hex>  <name>`, the
/// name possibly marked `*` for binary mode), in lowercase.
fn published_sum(text: &str, name: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let sum = parts.next()?;
        let file = parts.next()?.trim_start_matches('*');
        (file == name && sum.len() == 64 && sum.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| sum.to_ascii_lowercase())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_published_sum_is_found_by_file_name() {
        let a = "a".repeat(64);
        let b = "B".repeat(64);
        let text = format!("{a}  yt-dlp.exe\n{b} *yt-dlp_linux\n{a}  yt-dlp_linux.zip\n");
        assert_eq!(published_sum(&text, "yt-dlp_linux"), Some("b".repeat(64)));
        assert_eq!(published_sum(&text, "yt-dlp_macos"), None);
        assert_eq!(published_sum("short  yt-dlp_linux\n", "yt-dlp_linux"), None);
    }

    #[test]
    fn release_tags_are_dates() {
        assert!(is_tag("2026.11.20"));
        assert!(is_tag("2026.11.20.1"));
        assert!(!is_tag(""));
        assert!(!is_tag("../evil"));
    }
}
