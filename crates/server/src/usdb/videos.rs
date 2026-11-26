//! The video picker: the video candidates for a USDB song, and what yt-dlp
//! reads about each one.
//!
//! Candidates come in a fixed order: the `v=` and `a=` tags of the `#VIDEO`
//! header in USDB's text, then the links in the song's comments (newest
//! first), then the top yt-dlp search hits for `Artist - Title` with Shorts
//! excluded. A link already offered is not offered again.
//!
//! The picker's yt-dlp lookups (the search and each candidate's details) run
//! one at a time through [`VideoLookups`], their own queue: they take no
//! place in the job runner's Download lane, so a running Download never
//! delays them.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::UserMessage;
use openstar_protocol::usdb::{
    UsdbVideoCandidates, VIDEO_SEARCH_HITS, VideoCandidate, VideoDetails, VideoDetailsQuery,
    VideoSource,
};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use tokio::sync::watch;

use super::detail::normalise_video_link;
use super::song_txt::header_lines;
use super::{comment_links, parse_gettxt, video_tag_links};
use crate::AppState;
use crate::jobs::Slot;
use crate::ytdlp::{IMAGE_PROGRAM, YtDlp};

/// How long one lookup may take before it counts as failed (and its yt-dlp
/// is killed), so one stuck lookup cannot hold the queue.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(60);

/// The picker's yt-dlp queue. Cheap to clone; clones share the queue.
#[derive(Clone)]
pub(crate) struct VideoLookups {
    ytdlp: YtDlp,
    /// Held for the whole of one lookup. Tokio's mutex is fair, so lookups
    /// run in the order they were asked for.
    queue: Arc<tokio::sync::Mutex<()>>,
}

/// A search hit, as `--flat-playlist -j` prints it.
#[derive(Debug, Deserialize)]
struct FlatEntry {
    url: Option<String>,
    webpage_url: Option<String>,
    #[serde(flatten)]
    info: Info,
}

/// The fields of yt-dlp's JSON the picker shows.
#[derive(Debug, Deserialize)]
struct Info {
    title: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    #[serde(default)]
    thumbnails: Vec<Thumbnail>,
}

#[derive(Debug, Deserialize)]
struct Thumbnail {
    url: Option<String>,
}

impl Info {
    fn details(self) -> VideoDetails {
        // yt-dlp lists thumbnails from worst to best.
        let thumbnail = self
            .thumbnail
            .or_else(|| self.thumbnails.into_iter().rev().find_map(|t| t.url));
        VideoDetails {
            title: self.title.unwrap_or_default(),
            duration_seconds: self.duration.filter(|d| d.is_finite() && *d >= 0.0),
            thumbnail,
        }
    }
}

/// A search hit: its link and what the flat search already read.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SearchHit {
    pub url: String,
    pub details: VideoDetails,
}

impl VideoLookups {
    pub(crate) fn new(ytdlp: YtDlp) -> Self {
        Self {
            ytdlp,
            queue: Arc::default(),
        }
    }

    /// Runs yt-dlp with `args` in the queue and collects its stdout lines.
    async fn run(&self, args: Vec<String>) -> Result<Vec<String>, UserMessage> {
        let _turn = self.queue.lock().await;
        let program = self.ytdlp.program().await;
        let (_never, cancel) = watch::channel(false);
        let slot = Slot::outside_lanes(self.ytdlp.tool_path(), cancel);
        let mut command = slot.command(&program);
        for arg in args {
            command = command.arg(arg);
        }
        let mut lines = Vec::new();
        // Dropping the run on timeout kills the child (`kill_on_drop`).
        match tokio::time::timeout(
            LOOKUP_TIMEOUT,
            command.run_lines(|line| {
                lines.push(line.to_owned());
            }),
        )
        .await
        {
            Ok(Ok(())) => Ok(lines),
            Ok(Err(message)) => Err(message),
            Err(_) => {
                tracing::warn!("a yt-dlp lookup for the video picker timed out");
                Err(UserMessage::ToolFailed {
                    tool: IMAGE_PROGRAM.to_owned(),
                    exit_code: None,
                })
            }
        }
    }

    /// The top search hits for `query`, Shorts excluded.
    pub(crate) async fn search(&self, query: &str) -> Result<Vec<SearchHit>, UserMessage> {
        let lines = self
            .run(vec![
                "--flat-playlist".to_owned(),
                "-j".to_owned(),
                "--match-filter".to_owned(),
                "url!*=/shorts/ & original_url!*=/shorts/".to_owned(),
                "--".to_owned(),
                format!("ytsearch{VIDEO_SEARCH_HITS}:{query}"),
            ])
            .await?;
        Ok(lines
            .iter()
            .filter_map(|line| serde_json::from_str::<FlatEntry>(line).ok())
            .filter_map(|entry| {
                let url = entry.webpage_url.or(entry.url)?;
                Some(SearchHit {
                    url: normalise_video_link(&url),
                    details: entry.info.details(),
                })
            })
            .collect())
    }

    /// What yt-dlp reads about the video at `url`.
    pub(crate) async fn details(&self, url: &str) -> Result<VideoDetails, UserMessage> {
        let lines = self
            .run(vec![
                "-j".to_owned(),
                "--no-playlist".to_owned(),
                "--".to_owned(),
                url.to_owned(),
            ])
            .await?;
        lines
            .iter()
            .find_map(|line| serde_json::from_str::<Info>(line).ok())
            .map(Info::details)
            .ok_or_else(|| {
                tracing::warn!(url, "yt-dlp printed no video details");
                UserMessage::ToolFailed {
                    tool: IMAGE_PROGRAM.to_owned(),
                    exit_code: None,
                }
            })
    }
}

/// The candidate list, in the picker's order, without repeats: `tags` (from
/// `#VIDEO`), then `comments`, then search `hits`.
pub(crate) fn candidates(
    tags: Vec<String>,
    comments: Vec<String>,
    hits: Vec<SearchHit>,
) -> Vec<VideoCandidate> {
    let mut list: Vec<VideoCandidate> = Vec::new();
    let tagged = tags
        .into_iter()
        .map(|url| (url, VideoSource::VideoTag, None))
        .chain(
            comments
                .into_iter()
                .map(|url| (url, VideoSource::Comment, None)),
        )
        .chain(
            hits.into_iter()
                .map(|hit| (hit.url, VideoSource::Search, Some(hit.details))),
        );
    for (url, source, details) in tagged {
        let url = normalise_video_link(&url);
        if !list.iter().any(|candidate| candidate.url == url) {
            list.push(VideoCandidate {
                url,
                source,
                details,
            });
        }
    }
    list
}

/// The Song's length from its text: `#END`, else the end of its last Note;
/// `None` when the text does not parse or has no Notes.
pub(crate) fn song_length_seconds(text: &str) -> Option<f64> {
    let file = crate::txt::parse(text.as_bytes(), "").ok()?;
    let headers = &file.song.headers;
    if let Some(end) = headers.end_seconds {
        return Some(end);
    }
    file.song
        .voices
        .iter()
        .flat_map(|voice| &voice.lines)
        .flat_map(|line| &line.notes)
        .map(|note| headers.seconds_at_beat(f64::from(note.start) + f64::from(note.length)))
        .reduce(f64::max)
}

/// `Artist - Title` for the search, from the text's headers.
fn query_from_text(text: &str) -> Option<String> {
    let headers = header_lines(text);
    let value = |key: &str| {
        headers
            .iter()
            .find(|header| header.key.eq_ignore_ascii_case(key))
            .and_then(|header| header.value)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    Some(format!("{} - {}", value("ARTIST")?, value("TITLE")?))
}

/// `GET /api/usdb/songs/{id}/videos`: the candidates, `502` with the code
/// when USDB could not be asked.
pub(crate) async fn candidates_for(State(state): State<AppState>, Path(id): Path<u32>) -> Response {
    match picker(&state, id).await {
        Ok(found) => Json(found).into_response(),
        Err(message) => (StatusCode::BAD_GATEWAY, Json(message)).into_response(),
    }
}

async fn picker(state: &AppState, id: u32) -> Result<UsdbVideoCandidates, UserMessage> {
    let text = parse_gettxt(&state.usdb.song_text_page(id).await?).ok();
    let detail = state.usdb.detail_page(id).await?;

    let mirrored = state
        .db
        .call(move |conn| {
            conn.query_row(
                "SELECT artist, title FROM usdb_songs WHERE usdb_id = ?1",
                [id],
                |row| {
                    Ok(format!(
                        "{} - {}",
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?
                    ))
                },
            )
            .optional()
        })
        .await
        .map_err(|error| {
            tracing::error!(?error, id, "reading a mirrored USDB song");
            UserMessage::ServerError
        })?;
    let query = mirrored.or_else(|| text.as_deref().and_then(query_from_text));

    let (hits, search_failure) = match query {
        Some(query) => match state.video_lookups.search(&query).await {
            Ok(hits) => (hits, None),
            Err(message) => (Vec::new(), Some(message)),
        },
        None => (Vec::new(), None),
    };
    let tags = text.as_deref().map(video_tag_links).unwrap_or_default();
    Ok(UsdbVideoCandidates {
        usdb_id: id,
        song_length_seconds: text.as_deref().and_then(song_length_seconds),
        candidates: candidates(tags, comment_links(&detail), hits),
        search_failure,
    })
}

/// `GET /api/usdb/video-details?url=`: `400` for anything but an `http(s)`
/// link, `502` with the code when yt-dlp cannot read it.
pub(crate) async fn details(
    State(state): State<AppState>,
    Query(query): Query<VideoDetailsQuery>,
) -> Response {
    let url = query.url.trim();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match state.video_lookups.details(url).await {
        Ok(details) => Json(details).into_response(),
        Err(message) => (StatusCode::BAD_GATEWAY, Json(message)).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(url: &str, title: &str) -> SearchHit {
        SearchHit {
            url: url.to_owned(),
            details: VideoDetails {
                title: title.to_owned(),
                duration_seconds: Some(200.0),
                thumbnail: None,
            },
        }
    }

    fn urls_and_sources(list: &[VideoCandidate]) -> Vec<(&str, VideoSource)> {
        list.iter()
            .map(|candidate| (candidate.url.as_str(), candidate.source))
            .collect()
    }

    #[test]
    fn tags_come_first_then_comments_then_search_hits() {
        let list = candidates(
            vec!["https://www.youtube.com/watch?v=AAAAAAAAAAA".to_owned()],
            vec!["https://vimeo.com/123456".to_owned()],
            vec![hit("https://www.youtube.com/watch?v=CCCCCCCCCCC", "Hit")],
        );
        assert_eq!(
            urls_and_sources(&list),
            [
                (
                    "https://www.youtube.com/watch?v=AAAAAAAAAAA",
                    VideoSource::VideoTag
                ),
                ("https://vimeo.com/123456", VideoSource::Comment),
                (
                    "https://www.youtube.com/watch?v=CCCCCCCCCCC",
                    VideoSource::Search
                ),
            ]
        );
        assert_eq!(list[2].details.as_ref().unwrap().title, "Hit");
        assert_eq!(
            list[0].details, None,
            "tags and comments are looked up later"
        );
    }

    #[test]
    fn a_link_already_offered_is_not_offered_again_in_any_shape() {
        let list = candidates(
            vec!["https://youtu.be/AAAAAAAAAAA".to_owned()],
            vec![
                "https://www.youtube.com/watch?v=AAAAAAAAAAA".to_owned(),
                "https://vimeo.com/1".to_owned(),
                "https://vimeo.com/1".to_owned(),
            ],
            vec![
                hit("https://www.youtube.com/watch?v=AAAAAAAAAAA", "Same"),
                hit("https://vimeo.com/1", "Same"),
                hit("https://www.youtube.com/watch?v=EEEEEEEEEEE", "New"),
            ],
        );
        assert_eq!(
            urls_and_sources(&list),
            [
                (
                    "https://www.youtube.com/watch?v=AAAAAAAAAAA",
                    VideoSource::VideoTag
                ),
                ("https://vimeo.com/1", VideoSource::Comment),
                (
                    "https://www.youtube.com/watch?v=EEEEEEEEEEE",
                    VideoSource::Search
                ),
            ]
        );
    }

    #[test]
    fn hosts_other_than_youtube_are_offered() {
        let list = candidates(
            vec!["https://example.bandcamp.com/track/song".to_owned()],
            vec!["https://www.dailymotion.com/video/x7abc".to_owned()],
            Vec::new(),
        );
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].url, "https://example.bandcamp.com/track/song");
    }

    #[test]
    fn the_song_length_is_end_else_the_last_note_end() {
        // BPM 15 → 60 real beats a minute → one beat a second; GAP 2 s.
        let text = "#ARTIST:A\n#TITLE:T\n#BPM:15\n#GAP:2000\n: 0 2 0 la\n- 4\n: 10 5 0 la\nE\n";
        assert_eq!(song_length_seconds(text), Some(17.0));
        let with_end = text.replace("#GAP:2000", "#GAP:2000\n#END:90500");
        assert_eq!(song_length_seconds(&with_end), Some(90.5));
        assert_eq!(song_length_seconds("not a song"), None);
    }

    #[test]
    fn the_search_query_falls_back_to_the_text_headers() {
        assert_eq!(
            query_from_text("#ARTIST: Some Artist \n#TITLE:Re: Stacks\n: 0 1 0 a\n").as_deref(),
            Some("Some Artist - Re: Stacks")
        );
        assert_eq!(query_from_text("#TITLE:Only\n"), None);
    }

    #[test]
    fn details_take_the_best_thumbnail_when_there_is_no_single_one() {
        let info: Info = serde_json::from_str(
            r#"{"title":"T","duration":12.5,"thumbnails":[{"url":"small"},{"url":"big"}]}"#,
        )
        .unwrap();
        assert_eq!(
            info.details(),
            VideoDetails {
                title: "T".to_owned(),
                duration_seconds: Some(12.5),
                thumbnail: Some("big".to_owned()),
            }
        );
    }
}
