//! A Song's Pitch track, as browsers ask for it.
//!
//! - `POST /api/songs/{id}/pitch-track` answers [`PitchTrackStart`]: the
//!   cached track is ready, or a Pitch track job computes it (a job already
//!   computing it is joined, never doubled). The job's progress and end
//!   reach every browser as `ServerMessage::JobChanged`; a failure or a
//!   timeout ends it with `UserMessage::PitchTrackFailed`.
//! - `GET /api/songs/{id}/pitch-track` answers the cached track's frames as
//!   they are stored (`application/octet-stream`): one frame every 10 ms of
//!   three little-endian `f32` values, pitch (Hz, 0 = unvoiced), clarity
//!   and RMS envelope, in that order. `404` when no current track is cached.
//!
//! Neither needs an Unlock: they change no file and delete no kept data.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::jobs::JobId;

/// Answer of `POST /api/songs/{id}/pitch-track`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum PitchTrackStart {
    /// The cached track is current: download it now.
    Ready,
    /// Job `job` computes the track; download it once that job is done.
    Computing { job: JobId },
}
