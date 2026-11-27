//! USDB, the song database Downloads come from.
//!
//! - `GET /api/usdb/status`: the [`UsdbStatus`], for the Downloads section's
//!   notices (not guarded).
//! - `GET /api/usdb/mirror`: the [`UsdbMirrorStatus`] (not guarded).
//! - `POST /api/usdb/mirror/refresh`: the Downloads section asks for a fresh
//!   mirror when it opens; an update starts only when the mirror is more than
//!   a day old (a full refetch when one is due). Answers the
//!   [`UsdbMirrorStatus`] (not guarded).
//! - `POST /api/usdb/mirror/refetch`: starts a full refetch by hand unless a
//!   mirror run is already queued or running. Answers the
//!   [`UsdbMirrorStatus`] (not guarded: the mirror is a copy of USDB, not
//!   kept data).
//!
//! - `GET /api/usdb/songs?<UsdbSearchQuery>`: the [`UsdbSearchResults`],
//!   searched on the mirror alone, so a search never costs USDB a request
//!   (not guarded). Answers from what is mirrored so far while the mirror
//!   fills.
//! - `GET /api/usdb/songs/{id}/cover`: the song's USDB cover, fetched from
//!   USDB (through its paced queue) the first time it is asked for and served
//!   from the cache in `/appdata/cache` after that; `404` when USDB has none
//!   (not guarded).
//!
//! - `GET /api/usdb/songs/{id}/videos`: the video picker's
//!   [`UsdbVideoCandidates`] for a USDB song (not guarded: only starting a
//!   Download needs the Admin PIN). The server reads the song's text and
//!   detail page through USDB's paced queue and runs the yt-dlp search.
//! - `GET /api/usdb/video-details?<VideoDetailsQuery>`: what yt-dlp reads
//!   about one candidate, [`VideoDetails`]; `502` with the code when yt-dlp
//!   cannot read it (show the candidate as unavailable). Not guarded.
//!
//! The picker's yt-dlp lookups (the search and every candidate's details)
//! run one at a time in their own queue, outside the Download cap.
//!
//! - `POST /api/downloads` with a [`StartDownload`]: starts a Download of a
//!   USDB song from the chosen video (**guarded**, and refused on a
//!   read-only Library with `409 libraryReadOnly`). Answers
//!   [`DownloadStarted`] with the job's id; `409` with
//!   [`UserMessage::UsdbSongInLibrary`] when the USDB id is already in the
//!   Library, or [`UserMessage::UsdbCredentialsMissing`] without the USDB
//!   login; `400` with [`UserMessage::InvalidMessage`] for a video link that
//!   is not `http(s)://`. The Download runs as a job of kind `download`.
//! - `GET /api/usdb/songs/{id}/version`: which USDB version of the text the
//!   Library holds for the id, [`UsdbTextVersion`] (not guarded).
//!
//! Progress and completion of a mirror run reach browsers as
//! [`ServerMessage::JobChanged`](crate::ServerMessage::JobChanged) (kinds
//! `usdbMirrorRefetch` and `usdbMirrorUpdate`) and as
//! [`ChangeTopic::UsdbMirror`](crate::ChangeTopic::UsdbMirror) notices.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::UserMessage;
use crate::jobs::JobId;
use crate::party::PhoneId;
use crate::profile::PaletteKey;

/// The most results `GET /api/usdb/songs` answers; `total` says how many
/// matched.
pub const USDB_SEARCH_LIMIT: u32 = 50;

/// Body of `GET /api/usdb/status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsdbStatus {
    pub state: UsdbState,
}

/// Where OpenStar's USDB login stands. Only `loggedIn` lets Downloads and
/// the mirror run; every other state is a notice in the Downloads section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UsdbState {
    /// `OPENSTAR_USDB_USERNAME` and `OPENSTAR_USDB_PASSWORD` are not set, so
    /// OpenStar never contacts USDB.
    CredentialsMissing,
    /// The login made at start is still being checked.
    Checking,
    /// The profile page shows the login.
    LoggedIn,
    /// USDB did not accept the username and password.
    LoginFailed,
    /// USDB could not be reached (no connection, or no answer in time).
    Unreachable,
    /// USDB kept answering "too many requests" or a server error, and
    /// OpenStar gave up after backing off.
    GaveUp,
}

/// Body of `GET /api/usdb/mirror` and of the mirror's `POST` endpoints:
/// where OpenStar's copy of USDB's song list stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsdbMirrorStatus {
    pub state: UsdbMirrorState,
    /// How many USDB songs the mirror holds now (searchable at once, also
    /// while it fills).
    pub songs: u32,
    /// When the last mirror run (update or full refetch) ended well, in Unix
    /// milliseconds; `null` before the first one.
    #[ts(type = "number | null")]
    pub last_refreshed_ms: Option<i64>,
    /// When the last full refetch ended well, in Unix milliseconds; `null`
    /// while the first fill has not finished.
    #[ts(type = "number | null")]
    pub last_full_ms: Option<i64>,
    /// Why the latest mirror run failed, when it did and no run has started
    /// since.
    pub last_failure: Option<UserMessage>,
}

/// The mirror's state, for the Downloads section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum UsdbMirrorState {
    /// No mirror run can start, for `reason` (v1: `usdbCredentialsMissing`).
    Unavailable { reason: UserMessage },
    /// Nothing is mirrored and no run is queued or running.
    Empty,
    /// The first fill is queued or running; `percent` once known.
    Filling { percent: Option<u8> },
    /// A run is queued or running over a filled mirror: a full refetch when
    /// `full`, else an update.
    Refreshing { full: bool, percent: Option<u8> },
    /// Songs are mirrored but the first fill never finished (it failed or
    /// was cancelled); the next refresh starts it again.
    Incomplete,
    /// Filled, and refreshed less than a day ago.
    Fresh,
    /// Filled, and last refreshed more than a day ago.
    Stale,
}

/// A search over the USDB mirror, sent as the URL query of
/// `GET /api/usdb/songs` (`?search=queen&sort=rating`). Both fields are
/// optional.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct UsdbSearchQuery {
    /// Words that must each appear in the song's artist or title, compared
    /// as the Library's search compares them (Unicode case folding).
    pub search: Option<String>,
    /// The order of the results; `views` when absent.
    pub sort: Option<UsdbSort>,
}

/// How USDB search results are sorted: most first, ties by the other value,
/// then by USDB id.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UsdbSort {
    /// Highest rating first.
    Rating,
    /// Most views first.
    #[default]
    Views,
}

/// Body of `GET /api/usdb/songs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsdbSearchResults {
    /// The first [`USDB_SEARCH_LIMIT`] matches, in the asked order.
    pub songs: Vec<UsdbSong>,
    /// How many mirrored songs match in all.
    pub total: u32,
}

/// One song of the USDB mirror, as a search result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsdbSong {
    pub usdb_id: u32,
    pub artist: String,
    pub title: String,
    pub genre: String,
    pub year: Option<u16>,
    pub edition: String,
    pub golden: bool,
    pub language: String,
    pub creator: String,
    /// 0 to 5, in halves.
    pub rating: f32,
    pub views: u32,
    /// A playable Song with this USDB id is in the Library now.
    pub in_library: bool,
    /// The cover's URL on this server (`/api/usdb/songs/{id}/cover`). It
    /// answers `404` when USDB has no cover: show the tile then.
    pub cover: String,
    /// The tile's colour when there is no cover: the one the Library picks
    /// for a Song with this USDB id.
    pub tile_colour: PaletteKey,
}

/// How many yt-dlp search hits the video picker offers at most.
pub const VIDEO_SEARCH_HITS: u32 = 5;

/// Body of `GET /api/usdb/songs/{id}/videos`: the video candidates for one
/// USDB song, in the order the picker shows them (the first is
/// preselected).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsdbVideoCandidates {
    pub usdb_id: u32,
    /// The Song's length from USDB's text (`#END`, else the end of its last
    /// Note), to set beside each candidate's duration; `null` when the text
    /// gives none.
    pub song_length_seconds: Option<f64>,
    /// `#VIDEO` tags first, then comment links (newest comment first), then
    /// yt-dlp search hits; a link already offered is not offered again.
    pub candidates: Vec<VideoCandidate>,
    /// Why the yt-dlp search found nothing, when it failed (the other
    /// candidates are still offered).
    pub search_failure: Option<UserMessage>,
}

/// One video the admin can download a USDB song's audio and video from. Any
/// host yt-dlp supports.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VideoCandidate {
    pub url: String,
    pub source: VideoSource,
    /// Already known for a search hit; otherwise ask
    /// `GET /api/usdb/video-details` for it.
    pub details: Option<VideoDetails>,
}

/// Where a video candidate came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum VideoSource {
    /// A `v=` or `a=` tag of the `#VIDEO` header in USDB's text: the video
    /// the text was timed to.
    VideoTag,
    /// A link in the song's USDB comments.
    Comment,
    /// A yt-dlp search hit for `Artist - Title`.
    Search,
}

/// What yt-dlp reads about a video.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VideoDetails {
    pub title: String,
    pub duration_seconds: Option<f64>,
    /// The thumbnail's URL on the video's host.
    pub thumbnail: Option<String>,
}

/// The URL query of `GET /api/usdb/video-details`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VideoDetailsQuery {
    /// An `http://` or `https://` link.
    pub url: String,
}

/// Body of `POST /api/downloads`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StartDownload {
    pub usdb_id: u32,
    /// The video picked in the video picker: an `http://` or `https://` link
    /// on any host yt-dlp supports.
    pub video_url: String,
    /// The browser that starts the Download: its Phone id (every browser
    /// keeps one, the Stage computer's too), so that browser alone can offer
    /// "Add to Queue" once it is done.
    pub browser: PhoneId,
}

/// Answer of `POST /api/downloads`: the Download's job, whose progress and
/// end reach every browser as `JobChanged`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DownloadStarted {
    pub job_id: JobId,
}

/// Which USDB version of the text the Library holds for a USDB id
/// (`GET /api/usdb/songs/{id}/version`). v1 only records it, so offering a
/// newer USDB text can be built later.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum UsdbTextVersion {
    /// No Library Song has this USDB id.
    NotInLibrary,
    /// A Library Song has it, but OpenStar did not download it (it came
    /// from before OpenStar), so the version is not known.
    Unknown,
    /// OpenStar downloaded it: USDB's `lastchange` of the song then (Unix
    /// seconds; `None` when the mirror did not hold the song yet) and the
    /// SHA-256 of `song.txt` exactly as written, in lower-case hex.
    Known {
        #[ts(type = "number | null")]
        last_change: Option<i64>,
        txt_sha256: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_status_is_a_camel_case_code() {
        let status = UsdbStatus {
            state: UsdbState::CredentialsMissing,
        };
        assert_eq!(
            serde_json::to_string(&status).unwrap(),
            r#"{"state":"credentialsMissing"}"#
        );
    }

    #[test]
    fn usdb_errors_are_codes_with_parameters() {
        assert_eq!(
            serde_json::to_string(&UserMessage::UsdbGaveUp { status: 503 }).unwrap(),
            r#"{"code":"usdbGaveUp","params":{"status":503}}"#
        );
        assert_eq!(
            serde_json::to_string(&UserMessage::UsdbUnreachable).unwrap(),
            r#"{"code":"usdbUnreachable"}"#
        );
    }
}
