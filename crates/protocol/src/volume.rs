//! The OpenStar volume: one value per Stage, kept per (Stage browser, Stage
//! output), set from the Stage's `+`/`-` keys or any Remote, with no Admin
//! PIN. The Stage applies it to its gain chain as `(v/100)²`
//! (`web/src/playback/gain.ts`, whose `OPENSTAR_VOLUME` mirrors these
//! constants; `web/checks/openstarVolume.test.ts` keeps them equal).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The lowest OpenStar volume.
pub const VOLUME_MIN: u8 = 0;
/// The highest OpenStar volume.
pub const VOLUME_MAX: u8 = 100;
/// One `+` or `-` press.
pub const VOLUME_STEP: u8 = 5;
/// Where a Stage output with no stored volume starts.
pub const VOLUME_DEFAULT: u8 = 80;

/// One step of the OpenStar volume, up or down.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum VolumeStep {
    Up,
    Down,
}

impl VolumeStep {
    /// The volume one step from `volume`, kept within 0..=100 and on the
    /// 5-step grid (a value off the grid snaps to the next one in the step's
    /// direction).
    pub fn apply(self, volume: u8) -> u8 {
        let volume = volume.min(VOLUME_MAX);
        let below = volume - volume % VOLUME_STEP;
        match self {
            Self::Up => (below + VOLUME_STEP).min(VOLUME_MAX),
            Self::Down if below < volume => below,
            Self::Down => below.saturating_sub(VOLUME_STEP),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_moves_by_five_within_zero_to_one_hundred() {
        assert_eq!(VolumeStep::Up.apply(80), 85);
        assert_eq!(VolumeStep::Down.apply(80), 75);
        assert_eq!(VolumeStep::Up.apply(100), 100);
        assert_eq!(VolumeStep::Up.apply(95), 100);
        assert_eq!(VolumeStep::Down.apply(0), 0);
        assert_eq!(VolumeStep::Down.apply(5), 0);
    }

    #[test]
    fn a_value_off_the_grid_snaps_to_it_in_the_steps_direction() {
        assert_eq!(VolumeStep::Up.apply(82), 85);
        assert_eq!(VolumeStep::Down.apply(82), 80);
        assert_eq!(VolumeStep::Down.apply(250), 95);
    }
}
