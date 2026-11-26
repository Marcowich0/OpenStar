//! The A/V offset: how much later the room hears a browser's sound than its
//! screen shows it, in milliseconds (positive: the sound arrives later than
//! the picture). It shifts only what is drawn against Song time, never the
//! video or the Score. One value is kept per (browser, output key), read and
//! set by that browser itself at `GET`/`PUT /api/av-offset`, with no Admin
//! PIN. The frontend mirrors these constants in `web/src/avOffset/avOffset.ts`
//! (`AV_OFFSET`; `web/checks/avOffset.test.ts` keeps them equal).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The lowest A/V offset: a TV that delays its picture while the sound goes
/// to faster speakers.
pub const AV_OFFSET_MIN_MS: i32 = -300;
/// The highest A/V offset: Bluetooth.
pub const AV_OFFSET_MAX_MS: i32 = 500;
/// One step of the A/V offset.
pub const AV_OFFSET_STEP_MS: i32 = 10;
/// Where an output with no stored A/V offset starts.
pub const AV_OFFSET_DEFAULT_MS: i32 = 0;

/// Whether `ms` is an A/V offset: within -300..=500 and on the 10 ms grid.
pub fn is_av_offset(ms: i32) -> bool {
    (AV_OFFSET_MIN_MS..=AV_OFFSET_MAX_MS).contains(&ms) && ms % AV_OFFSET_STEP_MS == 0
}

/// Query of `GET /api/av-offset`: which browser's value, at which output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AvOffsetQuery {
    /// The browser's random id (`stageBrowserId`, kept in its local storage).
    pub browser: String,
    /// The output key: the default output's label without "Default - ".
    pub output: String,
}

/// One browser's A/V offset at one output: the body of `GET /api/av-offset`
/// (0 when nothing is stored) and of `PUT /api/av-offset`, both ways.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AvOffset {
    pub browser: String,
    pub output: String,
    /// -300..=500, in 10 ms steps.
    pub av_offset_ms: i32,
}

/// One press during Check A/V sync, from the Stage or any Remote: one
/// 10 ms step down (`−`, `←`) or up (`+`, `→`), or Reset to 0. The Stage
/// applies it to its own value and saves it under its own browser id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AvSyncStep {
    Down,
    Up,
    Reset,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_a_v_offset_is_minus_300_to_500_ms_in_10_ms_steps() {
        for ms in [-300, -10, 0, 10, 120, 500] {
            assert!(is_av_offset(ms), "{ms}");
        }
        for ms in [-310, -305, -1, 5, 125, 501, 510] {
            assert!(!is_av_offset(ms), "{ms}");
        }
        assert!(is_av_offset(AV_OFFSET_DEFAULT_MS));
    }
}
