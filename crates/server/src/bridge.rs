//! The server's own Mic bridge files under `/bridge/` (install script, bridge
//! binary, checksum). They sit outside the app: a file in the bridge folder
//! wins over the app's fallback, and any other `/bridge/…` path is the app's.
//!
//! Two names are not served as they are on disk:
//! - `install.sh` gets this server's address in place of [`ADDRESS_SLOT`]:
//!   `OPENSTAR_PUBLIC_URL` when it is set, otherwise the address the script
//!   was fetched from, so `curl -fsSL <address>/bridge/install.sh | sh`
//!   installs a bridge that talks to this server.
//! - `openstar-mic-bridge.sha256` is worked out from the binary on every
//!   request, in `sha256sum` format, so it always matches what is served.

use std::path::Path;

use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};

use crate::{AppState, frontend};

/// Where the Docker image puts the bridge build matching this server.
pub const DEFAULT_BRIDGE_DIR: &str = "/usr/share/openstar/bridge";

/// The bridge binary's file name.
pub const BINARY: &str = "openstar-mic-bridge";
const CHECKSUM: &str = "openstar-mic-bridge.sha256";
const INSTALL_SCRIPT: &str = "install.sh";
/// The text in `install.sh` the server's address replaces.
pub const ADDRESS_SLOT: &str = "@OPENSTAR_SERVER@";

/// Serves `/bridge/{file}` from the bridge folder, or the app when there is no such file.
pub async fn serve(
    State(state): State<AppState>,
    UrlPath(file): UrlPath<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if file == CHECKSUM {
        return match read(&state.bridge_dir, BINARY).await {
            Some(binary) => plain("text/plain; charset=utf-8", checksum_line(&binary)),
            None => StatusCode::NOT_FOUND.into_response(),
        };
    }
    let Some(bytes) = read(&state.bridge_dir, &file).await else {
        return frontend::serve(uri).await;
    };
    if file == INSTALL_SCRIPT {
        let Some(address) = install_address(state.config.public_url.as_deref(), &headers) else {
            return (StatusCode::BAD_REQUEST, "not a plain host name\n").into_response();
        };
        let script = String::from_utf8_lossy(&bytes).replace(ADDRESS_SLOT, &address);
        return plain("text/x-shellscript; charset=utf-8", script);
    }
    let mime = mime_guess::from_path(&file).first_or_octet_stream();
    plain(mime.as_ref(), bytes)
}

fn plain(content_type: &str, body: impl Into<Body>) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type.to_owned()),
            (header::CACHE_CONTROL, "no-cache".to_owned()),
        ],
        body.into(),
    )
        .into_response()
}

/// `<hex>  openstar-mic-bridge\n`, as `sha256sum` prints it.
fn checksum_line(binary: &[u8]) -> String {
    let hex: String = Sha256::digest(binary)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{hex}  {BINARY}\n")
}

/// The address the install script gives the bridge: `public_url` when set,
/// otherwise the request's `Host` (`https` when a proxy says so with
/// `X-Forwarded-Proto`). `None` for a host that is not a plain name, IP
/// address or `[IPv6]`, with an optional port: it goes into a shell script.
fn install_address(public_url: Option<&str>, headers: &HeaderMap) -> Option<String> {
    let plain = |text: &str| {
        !text.is_empty()
            && text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-:[]_".contains(&b))
    };
    if let Some(url) = public_url {
        let host = url.split_once("://").map_or("", |(_, rest)| rest);
        return plain(host).then(|| url.to_owned());
    }
    let host = headers.get(header::HOST)?.to_str().ok()?;
    if !plain(host) {
        return None;
    }
    let https = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|proto| proto.trim().eq_ignore_ascii_case("https"));
    let scheme = if https { "https" } else { "http" };
    Some(format!("{scheme}://{host}"))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn host(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, value.parse().unwrap());
        headers
    }

    #[test]
    fn the_public_url_wins_over_the_host() {
        assert_eq!(
            install_address(Some("https://o.example"), &host("10.0.0.5:8080")).as_deref(),
            Some("https://o.example")
        );
    }

    #[test]
    fn plain_hosts_and_ip_addresses_are_kept() {
        for value in ["10.0.0.5:8080", "[::1]:8080", "openstar.lan", "my_box"] {
            assert_eq!(
                install_address(None, &host(value)),
                Some(format!("http://{value}"))
            );
        }
        assert_eq!(install_address(None, &HeaderMap::new()), None);
    }

    #[test]
    fn the_checksum_is_in_sha256sum_format() {
        assert_eq!(
            checksum_line(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  openstar-mic-bridge\n"
        );
    }
}
