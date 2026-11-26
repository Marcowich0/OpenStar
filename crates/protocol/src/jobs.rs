//! Background jobs as browsers see them: `GET /api/jobs` and
//! [`ServerMessage::JobChanged`](crate::ServerMessage::JobChanged).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::UserMessage;

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
    /// Reads USDB's whole song list into the mirror and drops the songs USDB
    /// no longer has: the first fill, the weekly full refetch and one started
    /// by hand.
    UsdbMirrorRefetch,
    /// Reads USDB's song list newest change first into the mirror, until the
    /// first song older than the newest one already mirrored.
    UsdbMirrorUpdate,
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
}

/// Body of `GET /api/jobs`: every kept job, oldest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JobList {
    pub jobs: Vec<Job>,
}
