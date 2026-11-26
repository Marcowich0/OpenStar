//! USDB covers (`GET /api/usdb/songs/{id}/cover`). The mirror stores none:
//! a cover is fetched from USDB (through the client's paced queue) the
//! first time a browser shows it, written to `/appdata/cache/usdb-covers/`,
//! and served from there after that.
//!
//! USDB has no cover for a song when its cover URL answers 404 (or, should
//! it ever, an empty body). No file is written then, never a zero-byte one;
//! the server remembers the answer until it restarts, so showing the song
//! again asks USDB nothing. A browser shows the song's tile instead.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use axum::Json;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::UserMessage;
use tower_http::services::ServeFile;

use super::UsdbClient;
use crate::AppState;

/// The cover cache's folder below the appdata folder.
const CACHE_DIR: &str = "cache/usdb-covers";

/// The cover cache. Cheap to clone.
#[derive(Clone)]
pub(crate) struct Covers {
    inner: Arc<Inner>,
}

struct Inner {
    dir: PathBuf,
    /// Songs USDB answered no cover for, since the server started.
    none: Mutex<HashSet<u32>>,
    /// Held while fetching, so two browsers showing one cover fetch it once.
    fetching: tokio::sync::Mutex<()>,
}

impl Covers {
    pub(crate) fn new(appdata_dir: &std::path::Path) -> Self {
        Self {
            inner: Arc::new(Inner {
                dir: appdata_dir.join(CACHE_DIR),
                none: Mutex::new(HashSet::new()),
                fetching: tokio::sync::Mutex::new(()),
            }),
        }
    }

    fn file(&self, id: u32) -> PathBuf {
        self.inner.dir.join(format!("{id}.jpg"))
    }

    fn has_none(&self, id: u32) -> bool {
        self.inner
            .none
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&id)
    }

    /// What is known without asking USDB: `Some(Some(file))` cached,
    /// `Some(None)` USDB has none, `None` not known yet.
    async fn known(&self, id: u32) -> Option<Option<PathBuf>> {
        let file = self.file(id);
        if tokio::fs::try_exists(&file).await.unwrap_or(false) {
            return Some(Some(file));
        }
        self.has_none(id).then_some(None)
    }

    /// The cached cover of song `id`, fetched from USDB first when it is not
    /// cached yet; `None` when USDB has no cover.
    pub(crate) async fn get(
        &self,
        usdb: &UsdbClient,
        id: u32,
    ) -> Result<Option<PathBuf>, UserMessage> {
        if let Some(known) = self.known(id).await {
            return Ok(known);
        }
        let _fetching = self.inner.fetching.lock().await;
        if let Some(known) = self.known(id).await {
            return Ok(known);
        }
        match usdb.cover(id).await? {
            Some(bytes) if !bytes.is_empty() => {
                let file = self.file(id);
                self.write(&file, &bytes).await.map_err(|error| {
                    tracing::error!(?error, id, "caching a USDB cover");
                    UserMessage::ServerError
                })?;
                Ok(Some(file))
            }
            _ => {
                self.inner
                    .none
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(id);
                Ok(None)
            }
        }
    }

    /// Writes `bytes` to `file` through a partial file, so a cover is never
    /// cached half written.
    async fn write(&self, file: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
        tokio::fs::create_dir_all(&self.inner.dir).await?;
        let partial = file.with_extension("jpg.partial");
        tokio::fs::write(&partial, bytes).await?;
        tokio::fs::rename(&partial, file).await
    }
}

/// `GET /api/usdb/songs/{id}/cover`: the cover as a JPEG; `404` when USDB has
/// none (or OpenStar has no USDB credentials and it is not cached); `502`
/// with the code when USDB could not be asked.
pub(crate) async fn cover(
    State(state): State<AppState>,
    Path(id): Path<u32>,
    request: Request,
) -> Response {
    match state.usdb_covers.get(&state.usdb, id).await {
        Ok(Some(file)) => match ServeFile::new(&file).try_call(request).await {
            Ok(response) => response.map(axum::body::Body::new),
            Err(error) => {
                tracing::error!(%error, id, "serving a cached USDB cover");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Ok(None) | Err(UserMessage::UsdbCredentialsMissing) => StatusCode::NOT_FOUND.into_response(),
        Err(message) => (StatusCode::BAD_GATEWAY, Json(message)).into_response(),
    }
}
