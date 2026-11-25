//! The built frontend (`web/dist`), served from the same origin as the API.
//!
//! In a release build the files are embedded in the binary, so no Node is
//! needed at runtime. In a debug build `rust-embed` reads them from disk, so a
//! fresh `pnpm build` shows up without recompiling the server.

use axum::body::Body;
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../web/dist"]
#[allow_missing = true]
struct Assets;

/// Serves a built file, or `index.html` for any other path so the
/// frontend's router handles it. `/api/…` and `/ws…` never fall back.
pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path == "api" || path.starts_with("api/") || path.starts_with("ws") {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Some(response) = file(path, false) {
        return response;
    }
    file("index.html", true).unwrap_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            "the frontend is not built (run `just web-build`)",
        )
            .into_response()
    })
}

fn file(path: &str, is_fallback: bool) -> Option<Response> {
    if path.is_empty() {
        return file("index.html", is_fallback);
    }
    let asset = Assets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    // Vite puts content-hashed files under `assets/`; everything else may change.
    let cache = if path.starts_with("assets/") && !is_fallback {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Response::builder()
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(asset.data.into_owned()))
        .ok()
}
