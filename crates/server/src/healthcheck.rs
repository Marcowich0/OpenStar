//! `openstar healthcheck`: asks `/healthz` on this machine whether the
//! server is serving. The image's `HEALTHCHECK` runs it.

use std::time::Duration;

use anyhow::{Context, bail};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// How long the whole check may take.
pub const TIMEOUT: Duration = Duration::from_secs(5);

/// Succeeds when `GET /healthz` on `127.0.0.1:port` answers `200`.
pub async fn check(port: u16) -> anyhow::Result<()> {
    tokio::time::timeout(TIMEOUT, request(port))
        .await
        .with_context(|| format!("/healthz on port {port} did not answer within {TIMEOUT:?}"))?
}

async fn request(port: u16) -> anyhow::Result<()> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .with_context(|| format!("connecting to port {port}"))?;
    stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await?;
    // The status line is all we need: `HTTP/1.1 200 OK`.
    let mut head = Vec::new();
    let mut buffer = [0; 256];
    while !head.contains(&b'\n') && head.len() < 1024 {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        head.extend_from_slice(&buffer[..read]);
    }
    let head = String::from_utf8_lossy(&head);
    let status_line = head.lines().next().unwrap_or_default();
    match status_line.split_whitespace().nth(1) {
        Some("200") => Ok(()),
        _ => bail!("/healthz answered {status_line:?}"),
    }
}
