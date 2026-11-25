//! The server's own Mic bridge files under `/bridge/` (install script, bridge
//! binary, checksum). They sit outside the app: a file in the bridge folder
//! wins over the app's fallback, and any other `/bridge/…` path is the app's.

use std::path::Path;

use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::{Uri, header};
use axum::response::{IntoResponse, Response};

use crate::{AppState, frontend};

/// Where the Docker image puts the bridge build matching this server.
pub const DEFAULT_BRIDGE_DIR: &str = "/usr/share/openstar/bridge";

/// Serves `/bridge/{file}` from the bridge folder, or the app when there is no such file.
pub async fn serve(
    State(state): State<AppState>,
    UrlPath(file): UrlPath<String>,
    uri: Uri,
) -> Response {
    match read(&state.bridge_dir, &file).await {
        Some(bytes) => {
            let mime = mime_guess::from_path(&file).first_or_octet_stream();
            (
                [
                    (header::CONTENT_TYPE, mime.as_ref().to_owned()),
                    (header::CACHE_CONTROL, "no-cache".to_owned()),
                ],
                Body::from(bytes),
            )
                .into_response()
        }
        None => frontend::serve(uri).await,
    }
}

/// Reads one plain file directly inside `dir`. Names that could leave the
/// folder (separators, `.` and `..`, hidden files) are never looked up.
async fn read(dir: &Path, file: &str) -> Option<Vec<u8>> {
    if file.is_empty() || file.starts_with('.') || file.contains(['/', '\\', '\0']) {
        return None;
    }
    let path = dir.join(file);
    tokio::task::spawn_blocking(move || {
        if std::fs::metadata(&path).ok()?.is_file() {
            std::fs::read(&path).ok()
        } else {
            None
        }
    })
    .await
    .ok()?
}
