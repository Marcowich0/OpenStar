//! Background jobs as browsers see them: `GET /api/jobs` and
//! [`ServerMessage::JobChanged`](crate::ServerMessage::JobChanged).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::UserMessage;
use crate::party::PhoneId;

/// Names one background job while it is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JobId(#[ts(type = "number")] pub i64);

/// What a job does. Each area adds its own kinds (Downloads, media
/// conversions, Song loudness measurements, the Pitch track).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum JobKind {
    /// A harmless child process that proves the runner. Only tests start it.
    Test,
    /// Converts a media file the Stage cannot play into an H.264 + AAC MP4
    /// (an AAC MP4 for audio only) in the appdata cache.
    Conversion,
    /// Measures a Song's loudness (EBU R128 integrated, in LUFS) over its
    /// original audio file.
    Loudness,
    /// Computes a Song's Pitch track over its original audio file, one at a
    /// time at low priority, for Auto-fit and the Timing editor.
    PitchTrack,
    /// Reads USDB's whole song list into the mirror and drops the songs USDB
    /// no longer has: the first fill, the weekly full refetch and one started
    /// by hand.
    UsdbMirrorRefetch,
    /// Reads USDB's song list newest change first into the mirror, until the
    /// first song older than the newest one already mirrored.
    UsdbMirrorUpdate,
    /// A Download: a USDB song's text and cover, and the chosen video with
    /// yt-dlp, written into a temporary folder and moved into the Library
    /// as a new Song.
    Download,
}

/// Where a job stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum JobState {
    /// Waiting for a free slot in its lane.
    Queued,
    /// Running; `percent` once the job has said how far it is.
    Running {
        percent: Option<u8>,
    },
    Done,
    /// Ended without its result, for `reason`.
    Failed {
        reason: UserMessage,
    },
}

/// One background job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Job {
    pub id: JobId,
    pub kind: JobKind,
    pub state: JobState,
    /// What a Download fetches, and how fast while yt-dlp runs. Only on
    /// Download jobs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub download: Option<DownloadDetails>,
}

/// A Download job's details, for the Downloads list and the browser that
/// started it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DownloadDetails {
    pub usdb_id: u32,
    /// The song's artist and title as the USDB mirror held them when the
    /// Download started; `None` when the mirror did not hold the song.
    pub artist: Option<String>,
    pub title: Option<String>,
    /// The chosen video.
    pub video_url: String,
    /// The browser that started it.
    pub browser: PhoneId,
    /// How fast yt-dlp is fetching the video, while it runs; `None` before
    /// and after.
    pub rate: Option<DownloadRate>,
}

/// yt-dlp's last progress report for a running Download.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DownloadRate {
    /// `None` while yt-dlp does not know it yet.
    #[ts(type = "number | null")]
    pub bytes_per_second: Option<u64>,
    /// Seconds until the file being fetched is complete, when known.
    pub eta_seconds: Option<u32>,
}

/// Body of `GET /api/jobs`: every kept job, oldest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JobList {
    pub jobs: Vec<Job>,
}
