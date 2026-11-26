//! A fake of yt-dlp's official releases on GitHub, for the self-update
//! (#198): a local HTTP server shaped like
//! `https://github.com/yt-dlp/yt-dlp/releases`.
//!
//! - `GET /releases/latest` redirects (302) to `/releases/tag/<tag>` of the
//!   latest published release, or answers 404 when none is published.
//! - `GET /releases/tag/<tag>` answers 200.
//! - `GET /releases/download/<tag>/SHA2-256SUMS` answers the release's
//!   checksum file (`<hex>  <file name>` lines).
//! - `GET /releases/download/<tag>/yt-dlp_linux` answers the binary.
//!
//! [`FakeYtDlpReleases::fail_with`] makes every request answer a status
//! instead. Every request's path is recorded.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, PoisonError};

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use tokio::task::JoinHandle;

/// The binary's file name in a release.
pub const RELEASE_BINARY: &str = "yt-dlp_linux";
/// The checksum file's name in a release.
pub const RELEASE_SUMS: &str = "SHA2-256SUMS";

#[derive(Clone)]
struct Release {
    binary: Vec<u8>,
    sums: String,
}

#[derive(Default)]
struct Inner {
    latest: Mutex<Option<String>>,
    releases: Mutex<HashMap<String, Release>>,
    failing: Mutex<Option<StatusCode>>,
    requests: Mutex<Vec<String>>,
}

/// A running fake release server. It stops when dropped.
pub struct FakeYtDlpReleases {
    addr: SocketAddr,
    inner: Arc<Inner>,
    task: JoinHandle<()>,
}

impl FakeYtDlpReleases {
    /// Serves no release yet on a free local port.
    pub async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("binding a free local port");
        let addr = listener.local_addr().expect("the bound address");
        let inner = Arc::new(Inner::default());
        let app = Router::new().fallback(handle).with_state(inner.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { addr, inner, task }
    }

    /// The releases URL the app is given (`OPENSTAR_YTDLP_RELEASES_URL`):
    /// `http://127.0.0.1:<port>/releases`, without a trailing slash.
    pub fn releases_url(&self) -> String {
        format!("http://{}/releases", self.addr)
    }

    /// Publishes `binary` as the latest release `tag`, with its correct
    /// SHA-256 in the checksum file (beside a line for another file).
    pub fn publish(&self, tag: &str, binary: impl Into<Vec<u8>>) {
        let binary = binary.into();
        let sums = format!(
            "{}  yt-dlp.exe\n{}  {RELEASE_BINARY}\n",
            "0".repeat(64),
            openstar::ytdlp::sha256_hex(&binary)
        );
        self.publish_with_sums(tag, binary, sums);
    }

    /// Publishes `binary` as the latest release `tag` with `sums` as its
    /// checksum file, whatever it says.
    pub fn publish_with_sums(
        &self,
        tag: &str,
        binary: impl Into<Vec<u8>>,
        sums: impl Into<String>,
    ) {
        lock(&self.inner.releases).insert(
            tag.to_owned(),
            Release {
                binary: binary.into(),
                sums: sums.into(),
            },
        );
        *lock(&self.inner.latest) = Some(tag.to_owned());
    }

    /// From now on, every request answers `status` (`None`: normal again).
    pub fn fail_with(&self, status: Option<u16>) {
        *lock(&self.inner.failing) =
            status.map(|code| StatusCode::from_u16(code).expect("a valid status"));
    }

    /// Every request's path so far, in arrival order.
    pub fn requests(&self) -> Vec<String> {
        lock(&self.inner.requests).clone()
    }

    /// How many times the binary was downloaded.
    pub fn binary_downloads(&self) -> usize {
        self.requests()
            .iter()
            .filter(|path| path.ends_with(&format!("/{RELEASE_BINARY}")))
            .count()
    }

    /// How many times the latest release was asked for (one per update check).
    pub fn checks(&self) -> usize {
        self.requests()
            .iter()
            .filter(|path| *path == "/releases/latest")
            .count()
    }
}

impl Drop for FakeYtDlpReleases {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

async fn handle(State(inner): State<Arc<Inner>>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    lock(&inner.requests).push(path.clone());
    if let Some(status) = *lock(&inner.failing) {
        return status.into_response();
    }
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match parts.as_slice() {
        ["releases", "latest"] => match lock(&inner.latest).clone() {
            Some(tag) => (
                StatusCode::FOUND,
                [(header::LOCATION, format!("/releases/tag/{tag}"))],
            )
                .into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        },
        ["releases", "tag", tag] if lock(&inner.releases).contains_key(*tag) => {
            "a release page".into_response()
        }
        ["releases", "download", tag, file] => {
            let Some(release) = lock(&inner.releases).get(*tag).cloned() else {
                return StatusCode::NOT_FOUND.into_response();
            };
            match *file {
                RELEASE_SUMS => release.sums.into_response(),
                RELEASE_BINARY => release.binary.into_response(),
                _ => StatusCode::NOT_FOUND.into_response(),
            }
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}
