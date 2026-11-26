//! A Download: one USDB song's text and cover, and the chosen video with
//! yt-dlp, written into a temporary folder under `/appdata` and moved into
//! the Library as a new Song folder (see [`crate::library::Scanner::publish`]).
//!
//! The job's steps, in order:
//!
//! 1. it is refused when the USDB id is already in the Library;
//! 2. the text (`gettxt`, rewritten into `song.txt`) and the cover when USDB
//!    has one (`cover.jpg`, never a zero-byte file);
//! 3. the finished `song.txt` through the Library's parser: a rejected text
//!    fails the Download with the rejection before any video is fetched;
//! 4. the video with yt-dlp as `video.mp4`, H.264 MP4 and M4A preferred up to
//!    1080p;
//! 5. `metadata.json` (`{"apiId": <USDB id>, "video": "<chosen URL>"}`);
//! 6. the USDB id checked again, then the folder moved in and applied to the
//!    index, so the Song is in the Library at once;
//! 7. USDB's `lastchange` and the SHA-256 of `song.txt` as written stored
//!    against the USDB id ([`UsdbTextVersion`]).
//!
//! A failure, or a cancel, drops the temporary folder and nothing else; a
//! restart empties the temporary folders before any job runs, so an
//! interrupted Download starts again from scratch.

use std::path::Path;

use axum::Json;
use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::UserMessage;
use openstar_protocol::library::SongIdentity;
use openstar_protocol::party::PhoneId;
use openstar_protocol::usdb::{DownloadStarted, StartDownload, UsdbTextVersion};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{UsdbCover, parse_gettxt, rewrite_song_txt};
use crate::AppState;
use crate::db::Database;
use crate::jobs::{JobContext, JobParams};
use crate::library::{NewSongFolder, identity_present};

/// yt-dlp's format sort: H.264 first (the Stage decodes it in hardware),
/// then the best resolution up to 1080p, then MP4 video and M4A audio. A
/// sort, never a filter, so a video only offered in AV1 or VP9 is still
/// taken; the Library's codec check decides how it plays.
pub(crate) const FORMAT_SORT: &str = "vcodec:h264,res:1080,ext:mp4:m4a";

/// The one media file a Download writes, audio and video in one.
const VIDEO_FILE: &str = "video.mp4";

/// A stored Download job's parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub usdb_id: u32,
    /// The video picked in the picker, an `http(s)://` link.
    pub video_url: String,
    /// The browser that started it (its Phone id).
    pub browser: PhoneId,
}

/// Whether `url` may be handed to yt-dlp: only `http://` and `https://`
/// links, so nothing is ever read as an option or a local file.
fn is_web_link(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    url == url.trim() && (lower.starts_with("https://") || lower.starts_with("http://"))
}

/// Whether a Library Song has the USDB id `usdb_id`.
async fn in_library(db: &Database, usdb_id: u32) -> anyhow::Result<bool> {
    db.call(move |conn| identity_present(conn, &SongIdentity::Usdb { usdb_id }))
        .await
}

fn server_error(error: impl std::fmt::Debug, what: &str) -> UserMessage {
    tracing::error!(?error, "{what}");
    UserMessage::ServerError
}

impl DownloadJob {
    pub(crate) async fn run(self, ctx: &mut JobContext) -> Result<(), UserMessage> {
        let Some(usdb) = ctx.usdb.clone() else {
            return Err(UserMessage::UsdbCredentialsMissing);
        };
        let db = ctx.env.db.clone();
        let id = self.usdb_id;
        if in_library(&db, id)
            .await
            .map_err(|e| server_error(e, "checking the Library for a USDB id"))?
        {
            return Err(UserMessage::UsdbSongInLibrary);
        }
        let scanner = usdb.scanner().await;
        let staging = scanner.clone();
        let folder = tokio::task::spawn_blocking(move || staging.new_song_folder())
            .await
            .map_err(|e| server_error(e, "creating a Download's temporary folder"))?
            .map_err(|e| server_error(e, "creating a Download's temporary folder"))?;

        // 1. The text and the cover.
        let page = usdb.usdb.song_text_page(id).await?;
        let text = parse_gettxt(&page).map_err(|_| UserMessage::UsdbNoSongText)?;
        let cover = usdb.usdb.cover(id).await?.filter(|bytes| !bytes.is_empty());
        let has_cover = if cover.is_some() {
            UsdbCover::Present
        } else {
            UsdbCover::Absent
        };
        let song_txt = rewrite_song_txt(&text, has_cover).into_bytes();
        let sha256 = hex(&Sha256::digest(&song_txt));
        let parsed = crate::txt::parse(&song_txt, "")
            .map_err(|rejection| UserMessage::UsdbTextRejected { rejection })?;
        let headers = parsed.song.headers;
        let folder = write_files(folder, song_txt, cover).await?;
        ctx.progress.report(10);

        // 2. The video.
        let ytdlp = usdb.ytdlp.program().await;
        ctx.slot
            .command(&ytdlp)
            .arg("--newline")
            .arg("--no-playlist")
            .arg("-S")
            .arg(FORMAT_SORT)
            .arg("--merge-output-format")
            .arg("mp4")
            .arg("--remux-video")
            .arg("mp4")
            .arg("-P")
            .arg(folder.path())
            .arg("-o")
            .arg("video.%(ext)s")
            .arg("--")
            .arg(&self.video_url)
            .run_lines(|_| {})
            .await
            .map_err(|message| match message {
                UserMessage::ToolFailed { .. } => UserMessage::VideoDownloadFailed,
                other => other,
            })?;
        let folder = write_metadata(folder, id, self.video_url.clone()).await?;
        ctx.progress.report(90);

        // 3. Into the Library.
        if in_library(&db, id)
            .await
            .map_err(|e| server_error(e, "checking the Library for a USDB id"))?
        {
            return Err(UserMessage::UsdbSongInLibrary);
        }
        let published = scanner
            .publish(folder, &headers.artist, &headers.title)
            .await
            .map_err(|e| server_error(e, "moving a Download into the Library"))?;
        tracing::info!(usdb_id = id, folder = %published.folder, "a Download is in the Library");
        let now_ms = usdb.clock.now_millis();
        record_version(&db, id, sha256, now_ms)
            .await
            .map_err(|e| server_error(e, "storing a Download's USDB version"))?;
        ctx.progress.report(100);
        Ok(())
    }
}

/// Writes `song.txt` and, when USDB has one, `cover.jpg`.
async fn write_files(
    folder: NewSongFolder,
    song_txt: Vec<u8>,
    cover: Option<Vec<u8>>,
) -> Result<NewSongFolder, UserMessage> {
    tokio::task::spawn_blocking(move || {
        std::fs::write(folder.path().join("song.txt"), song_txt)?;
        if let Some(cover) = cover {
            std::fs::write(folder.path().join("cover.jpg"), cover)?;
        }
        Ok::<_, std::io::Error>(folder)
    })
    .await
    .map_err(|e| server_error(e, "writing a Download's text"))?
    .map_err(|e| server_error(e, "writing a Download's text"))
}

/// Checks that yt-dlp left a `video.mp4`, then writes `metadata.json`.
async fn write_metadata(
    folder: NewSongFolder,
    usdb_id: u32,
    video_url: String,
) -> Result<NewSongFolder, UserMessage> {
    tokio::task::spawn_blocking(move || {
        if !has_video(folder.path()) {
            tracing::warn!(usdb_id, "yt-dlp left no video.mp4");
            return Err(UserMessage::VideoDownloadFailed);
        }
        let metadata = serde_json::json!({ "apiId": usdb_id, "video": video_url });
        std::fs::write(folder.path().join("metadata.json"), metadata.to_string())
            .map_err(|e| server_error(e, "writing a Download's metadata.json"))?;
        Ok(folder)
    })
    .await
    .map_err(|e| server_error(e, "writing a Download's metadata.json"))?
}

fn has_video(folder: &Path) -> bool {
    std::fs::metadata(folder.join(VIDEO_FILE)).is_ok_and(|m| m.is_file() && m.len() > 0)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

/// Stores the USDB version a Download wrote: the mirror's `lastchange` for
/// the song (none when the mirror does not hold it) and the text's hash.
async fn record_version(
    db: &Database,
    usdb_id: u32,
    txt_sha256: String,
    now_ms: i64,
) -> anyhow::Result<()> {
    db.call(move |conn| {
        let last_change: Option<i64> = conn
            .query_row(
                "SELECT last_change FROM usdb_songs WHERE usdb_id = ?1",
                [usdb_id],
                |row| row.get(0),
            )
            .optional()?;
        conn.execute(
            "INSERT INTO usdb_downloads (usdb_id, last_change, txt_sha256, downloaded_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (usdb_id) DO UPDATE SET last_change = ?2, txt_sha256 = ?3,
                 downloaded_ms = ?4",
            params![usdb_id, last_change, txt_sha256, now_ms],
        )?;
        Ok(())
    })
    .await
}

/// The USDB version the Library holds for `usdb_id`.
async fn version(db: &Database, usdb_id: u32) -> anyhow::Result<UsdbTextVersion> {
    db.call(move |conn| {
        if !identity_present(conn, &SongIdentity::Usdb { usdb_id })? {
            return Ok(UsdbTextVersion::NotInLibrary);
        }
        let stored = conn
            .query_row(
                "SELECT last_change, txt_sha256 FROM usdb_downloads WHERE usdb_id = ?1",
                [usdb_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(match stored {
            Some((last_change, txt_sha256)) => UsdbTextVersion::Known {
                last_change,
                txt_sha256,
            },
            None => UsdbTextVersion::Unknown,
        })
    })
    .await
}

fn refused(status: StatusCode, message: UserMessage) -> Response {
    (status, Json(message)).into_response()
}

/// `POST /api/downloads` (guarded; refused on a read-only Library by the
/// guard): queues a Download, answers [`DownloadStarted`].
pub(crate) async fn start(
    State(state): State<AppState>,
    Json(body): Json<StartDownload>,
) -> Response {
    if !is_web_link(&body.video_url) {
        return refused(StatusCode::BAD_REQUEST, UserMessage::InvalidMessage);
    }
    if state.config.usdb.is_none() {
        return refused(StatusCode::CONFLICT, UserMessage::UsdbCredentialsMissing);
    }
    match in_library(&state.db, body.usdb_id).await {
        Ok(false) => {}
        Ok(true) => return refused(StatusCode::CONFLICT, UserMessage::UsdbSongInLibrary),
        Err(error) => {
            tracing::error!(?error, "checking the Library for a USDB id");
            return refused(StatusCode::INTERNAL_SERVER_ERROR, UserMessage::ServerError);
        }
    }
    let job = DownloadJob {
        usdb_id: body.usdb_id,
        video_url: body.video_url,
        browser: body.browser,
    };
    match state.jobs.enqueue(JobParams::Download(job)).await {
        Ok(job_id) => {
            tracing::info!(
                usdb_id = body.usdb_id,
                job = job_id.0,
                "a Download is queued"
            );
            Json(DownloadStarted { job_id }).into_response()
        }
        Err(error) => {
            tracing::error!(?error, "queueing a Download");
            refused(StatusCode::INTERNAL_SERVER_ERROR, UserMessage::ServerError)
        }
    }
}

/// `GET /api/usdb/songs/{id}/version`: [`UsdbTextVersion`] (not guarded).
pub(crate) async fn text_version(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<u32>,
) -> Response {
    match version(&state.db, id).await {
        Ok(version) => Json(version).into_response(),
        Err(error) => {
            tracing::error!(?error, "reading a USDB song's downloaded version");
            refused(StatusCode::INTERNAL_SERVER_ERROR, UserMessage::ServerError)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_links_reach_yt_dlp() {
        assert!(is_web_link("https://www.youtube.com/watch?v=AAAAAAAAAAA"));
        assert!(is_web_link("HTTP://vimeo.com/42"));
        assert!(!is_web_link("--exec=rm -rf /"));
        assert!(!is_web_link("file:///etc/passwd"));
        assert!(!is_web_link(" https://example.com"));
        assert!(!is_web_link("ytsearch5:something"));
    }

    #[test]
    fn stored_parameters_are_camel_case() {
        let job = JobParams::Download(DownloadJob {
            usdb_id: 7,
            video_url: "https://example.com/v".into(),
            browser: PhoneId("p".into()),
        });
        assert_eq!(
            serde_json::to_string(&job).unwrap(),
            r#"{"kind":"download","usdbId":7,"videoUrl":"https://example.com/v","browser":"p"}"#
        );
    }
}
