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
//! Each step that fetches (the text, the cover, the video) is tried up to
//! [`RETRIES`] more times after a failure that may pass, waiting
//! [`FIRST_RETRY_WAIT`] and then twice as long each time. Once yt-dlp's
//! error output says `HTTP Error 403: Forbidden`, later attempts ask
//! YouTube as other player clients ([`FORBIDDEN_FALLBACK`]).
//!
//! A failure, or a cancel (any time before the move, no PIN), drops the
//! temporary folder and nothing else; a restart empties the temporary
//! folders before any job runs, so an interrupted Download starts again
//! from scratch.

use std::future::Future;
use std::path::Path;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::UserMessage;
use openstar_protocol::jobs::{DownloadDetails, DownloadRate, JobId, JobKind, JobState};
use openstar_protocol::library::SongIdentity;
use openstar_protocol::party::PhoneId;
use openstar_protocol::usdb::{DownloadStarted, StartDownload, UsdbTextVersion};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::ytdlp_progress::{PROGRESS_TEMPLATE, parse_progress_line};
use super::{UsdbClient, UsdbCover, parse_gettxt, rewrite_song_txt};
use crate::AppState;
use crate::db::Database;
use crate::jobs::{JobContext, JobParams};
use crate::library::{NewSongFolder, identity_present};

/// How many more times a failed step is tried.
pub(crate) const RETRIES: u32 = 2;

/// The wait before a step's first retry; it doubles for each later one.
pub(crate) const FIRST_RETRY_WAIT: Duration = Duration::from_millis(1500);

/// What in yt-dlp's error output means YouTube refused the video.
const FORBIDDEN: &str = "HTTP Error 403: Forbidden";

/// The arguments later attempts add once YouTube refused a video.
const FORBIDDEN_FALLBACK: [&str; 2] = ["--extractor-args", "youtube:player_client=tv,web_embedded"];

/// The Download's percentage once its text is written, and once its video
/// is; the video's own progress fills the span between.
const TEXT_DONE: u8 = 10;
const VIDEO_DONE: u8 = 90;

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
    /// The song's artist and title in the USDB mirror when it started,
    /// for the Downloads list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
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

/// What a Download has ready to move into the Library.
struct Prepared {
    folder: NewSongFolder,
    artist: String,
    title: String,
    sha256: String,
}

/// Whether a step that failed with `message` is worth trying again: a
/// network or tool failure may pass, a refusal or a rejected text will not.
/// USDB's own backoff has already waited out a busy server
/// ([`UserMessage::UsdbGaveUp`]).
fn may_pass(message: &UserMessage) -> bool {
    matches!(
        message,
        UserMessage::UsdbUnreachable
            | UserMessage::UsdbNotLoggedIn
            | UserMessage::UsdbUnexpectedStatus { .. }
            | UserMessage::ToolFailed { .. }
            | UserMessage::VideoDownloadFailed
    )
}

/// The wait before retry `retry` (from 0): 1.5 s, 3 s, ...
pub(crate) fn retry_wait(retry: u32) -> Duration {
    FIRST_RETRY_WAIT * 2u32.saturating_pow(retry)
}

/// Runs `step` until it succeeds, fails for good, or has been retried
/// [`RETRIES`] times; waits on the USDB client's timer between tries.
async fn with_retries<T, F, Fut>(
    usdb: &UsdbClient,
    what: &str,
    mut step: F,
) -> Result<T, UserMessage>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, UserMessage>>,
{
    let mut retry = 0;
    loop {
        match step().await {
            Ok(value) => return Ok(value),
            Err(message) if retry < RETRIES && may_pass(&message) => {
                let wait = retry_wait(retry);
                tracing::info!(?message, ?wait, "a Download's {what} failed: trying again");
                usdb.wait(wait).await;
                retry += 1;
            }
            Err(message) => return Err(message),
        }
    }
}

/// Runs `work` unless the job is cancelled first: then `work` is dropped
/// (with any temporary folder it made) and the job ends cancelled. Not for
/// a child process, which [`crate::jobs::ToolCommand`] kills and reaps
/// itself.
async fn unless_cancelled<T>(
    ctx: &JobContext,
    work: impl Future<Output = Result<T, UserMessage>>,
) -> Result<T, UserMessage> {
    tokio::select! {
        biased;
        () = ctx.slot.cancelled() => Err(UserMessage::JobCancelled),
        done = work => done,
    }
}

/// The Download's percentage for yt-dlp's `percent` of the video.
fn video_percent(percent: f32) -> u8 {
    let span = f32::from(VIDEO_DONE - TEXT_DONE);
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "between TEXT_DONE and VIDEO_DONE"
    )]
    let into = (percent.clamp(0.0, 100.0) / 100.0 * span).floor() as u8;
    TEXT_DONE + into
}

impl DownloadJob {
    /// What browsers are shown about it.
    pub(crate) fn details(&self) -> DownloadDetails {
        DownloadDetails {
            usdb_id: self.usdb_id,
            artist: self.artist.clone(),
            title: self.title.clone(),
            video_url: self.video_url.clone(),
            browser: self.browser.clone(),
            rate: None,
        }
    }

    pub(crate) async fn run(self, ctx: &mut JobContext) -> Result<(), UserMessage> {
        let ctx = &*ctx;
        let Some(usdb) = ctx.usdb.clone() else {
            return Err(UserMessage::UsdbCredentialsMissing);
        };
        let db = ctx.env.db.clone();
        let id = self.usdb_id;
        // A cancel ends the steps, and drops the temporary folder with them.
        let prepared = self.prepare(ctx, &usdb).await?;
        if ctx.slot.is_cancelled() {
            return Err(UserMessage::JobCancelled);
        }

        // 3. Into the Library: past this point a cancel waits for the end.
        if in_library(&db, id)
            .await
            .map_err(|e| server_error(e, "checking the Library for a USDB id"))?
        {
            return Err(UserMessage::UsdbSongInLibrary);
        }
        let published = usdb
            .scanner()
            .await
            .publish(prepared.folder, &prepared.artist, &prepared.title)
            .await
            .map_err(|e| server_error(e, "moving a Download into the Library"))?;
        tracing::info!(usdb_id = id, folder = %published.folder, "a Download is in the Library");
        let now_ms = usdb.clock.now_millis();
        record_version(&db, id, prepared.sha256, now_ms)
            .await
            .map_err(|e| server_error(e, "storing a Download's USDB version"))?;
        ctx.progress.report(100);
        Ok(())
    }

    /// Steps 1 and 2: the text and cover, then the video, in a temporary
    /// folder.
    async fn prepare(
        &self,
        ctx: &JobContext,
        usdb: &crate::jobs::UsdbEnv,
    ) -> Result<Prepared, UserMessage> {
        let id = self.usdb_id;
        let client = &usdb.usdb;
        // 1. The text and the cover; a cancel stops waiting for USDB.
        let (folder, page, cover) = unless_cancelled(ctx, async {
            if in_library(&ctx.env.db, id)
                .await
                .map_err(|e| server_error(e, "checking the Library for a USDB id"))?
            {
                return Err(UserMessage::UsdbSongInLibrary);
            }
            let scanner = usdb.scanner().await;
            let folder = tokio::task::spawn_blocking(move || scanner.new_song_folder())
                .await
                .map_err(|e| server_error(e, "creating a Download's temporary folder"))?
                .map_err(|e| server_error(e, "creating a Download's temporary folder"))?;
            let page = with_retries(client, "text", || client.song_text_page(id)).await?;
            let cover = with_retries(client, "cover", || client.cover(id)).await?;
            Ok((folder, page, cover))
        })
        .await?;
        let text = parse_gettxt(&page).map_err(|_| UserMessage::UsdbNoSongText)?;
        let cover = cover.filter(|bytes| !bytes.is_empty());
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
        ctx.progress.report(TEXT_DONE);

        // 2. The video: a cancel kills yt-dlp (and waits for it to end).
        let ytdlp = usdb.ytdlp.program().await;
        let mut forbidden = false;
        let mut highest = TEXT_DONE;
        let mut retry = 0;
        loop {
            let attempt = self
                .fetch_video(ctx, &ytdlp, folder.path(), forbidden, &mut highest)
                .await
                .and_then(|()| check_video(folder.path()).map_err(Into::into));
            match attempt {
                Ok(()) => break,
                Err(failure) => {
                    if failure.stderr.iter().any(|line| line.contains(FORBIDDEN)) {
                        forbidden = true;
                    }
                    let message = match failure.message {
                        UserMessage::ToolFailed { .. } => UserMessage::VideoDownloadFailed,
                        other => other,
                    };
                    if retry >= RETRIES || !may_pass(&message) {
                        return Err(message);
                    }
                    let wait = retry_wait(retry);
                    tracing::info!(
                        usdb_id = id,
                        ?wait,
                        forbidden,
                        "a Download's video failed: trying again"
                    );
                    remove_partial_video(folder.path()).await;
                    unless_cancelled(ctx, async {
                        client.wait(wait).await;
                        Ok(())
                    })
                    .await?;
                    retry += 1;
                }
            }
        }
        let folder = write_metadata(folder, id, self.video_url.clone()).await?;
        ctx.progress.report(VIDEO_DONE);
        Ok(Prepared {
            folder,
            artist: headers.artist,
            title: headers.title,
            sha256,
        })
    }

    /// One yt-dlp run into `folder`, reporting its progress lines.
    async fn fetch_video(
        &self,
        ctx: &JobContext,
        ytdlp: &str,
        folder: &Path,
        forbidden: bool,
        highest: &mut u8,
    ) -> Result<(), crate::jobs::ToolFailure> {
        let mut command = ctx
            .slot
            .command(ytdlp)
            .arg("--newline")
            .arg("--progress-template")
            .arg(PROGRESS_TEMPLATE)
            .arg("--no-playlist")
            .arg("-S")
            .arg(FORMAT_SORT)
            .arg("--merge-output-format")
            .arg("mp4")
            .arg("--remux-video")
            .arg("mp4")
            .arg("-P")
            .arg(folder)
            .arg("-o")
            .arg("video.%(ext)s");
        if forbidden {
            for arg in FORBIDDEN_FALLBACK {
                command = command.arg(arg);
            }
        }
        command
            .arg("--")
            .arg(&self.video_url)
            .run_lines_with_stderr(|line| {
                let Some(progress) = parse_progress_line(line) else {
                    return;
                };
                // A video with separate audio is fetched as two files: the
                // percentage never goes back for the second one.
                *highest = (*highest).max(video_percent(progress.percent));
                ctx.progress.report_rate(
                    *highest,
                    DownloadRate {
                        bytes_per_second: progress.bytes_per_second,
                        eta_seconds: progress.eta_seconds,
                    },
                );
            })
            .await
    }
}

/// Removes what a failed yt-dlp run left in the temporary folder, so the
/// next attempt starts afresh: every file but the text and the cover.
async fn remove_partial_video(folder: &Path) {
    let folder = folder.to_owned();
    let _ = tokio::task::spawn_blocking(move || {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name != "song.txt" && name != "cover.jpg" {
                let path = entry.path();
                let removed = if path.is_dir() {
                    std::fs::remove_dir_all(&path)
                } else {
                    std::fs::remove_file(&path)
                };
                if let Err(error) = removed {
                    tracing::warn!(%error, path = %path.display(), "removing a failed video attempt");
                }
            }
        }
    })
    .await;
}

/// Whether yt-dlp left a `video.mp4`.
fn check_video(folder: &Path) -> Result<(), UserMessage> {
    if has_video(folder) {
        Ok(())
    } else {
        tracing::warn!(folder = %folder.display(), "yt-dlp left no video.mp4");
        Err(UserMessage::VideoDownloadFailed)
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
    let (artist, title) = match mirrored_name(&state.db, body.usdb_id).await {
        Ok(Some((artist, title))) => (Some(artist), Some(title)),
        Ok(None) => (None, None),
        Err(error) => {
            tracing::error!(?error, "reading a USDB song's name from the mirror");
            (None, None)
        }
    };
    let job = DownloadJob {
        usdb_id: body.usdb_id,
        video_url: body.video_url,
        browser: body.browser,
        artist,
        title,
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

/// The song's artist and title in the USDB mirror, when it holds the song.
async fn mirrored_name(db: &Database, usdb_id: u32) -> anyhow::Result<Option<(String, String)>> {
    db.call(move |conn| {
        conn.query_row(
            "SELECT artist, title FROM usdb_songs WHERE usdb_id = ?1",
            [usdb_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
    })
    .await
}

/// `POST /api/downloads/{id}/cancel` (not guarded: anyone may stop a
/// Download): cancels a waiting or running Download; its yt-dlp process is
/// stopped and its temporary folder removed. `204`, or `404` when `id` is no
/// waiting or running Download.
pub(crate) async fn cancel(State(state): State<AppState>, UrlPath(id): UrlPath<i64>) -> StatusCode {
    let id = JobId(id);
    let Some(jobs) = state.jobs.list().await else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    let cancellable = jobs.iter().any(|job| {
        job.id == id
            && job.kind == JobKind::Download
            && matches!(job.state, JobState::Queued | JobState::Running { .. })
    });
    if cancellable && state.jobs.cancel(id).await {
        tracing::info!(job = id.0, "a Download is cancelled");
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
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
            artist: None,
            title: None,
        });
        assert_eq!(
            serde_json::to_string(&job).unwrap(),
            r#"{"kind":"download","usdbId":7,"videoUrl":"https://example.com/v","browser":"p"}"#
        );
        let named: JobParams = serde_json::from_str(
            r#"{"kind":"download","usdbId":7,"videoUrl":"https://example.com/v","browser":"p","artist":"A","title":"T"}"#,
        )
        .unwrap();
        let JobParams::Download(named) = named else {
            panic!("a Download");
        };
        assert_eq!(named.details().title.as_deref(), Some("T"));
    }

    #[test]
    fn retries_wait_one_and_a_half_seconds_then_twice_as_long() {
        assert_eq!(RETRIES, 2);
        assert_eq!(retry_wait(0), Duration::from_millis(1500));
        assert_eq!(retry_wait(1), Duration::from_millis(3000));
    }

    #[test]
    fn the_video_fills_the_span_between_text_and_video() {
        assert_eq!(video_percent(0.0), 10);
        assert_eq!(video_percent(50.0), 50);
        assert_eq!(video_percent(100.0), 90);
        assert_eq!(video_percent(250.0), 90);
    }
}
