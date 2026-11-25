//! Scoring values the Stage computes and the server stores.
//!
//! The Stage turns each Mic's Pitch readings into one [`BeatValue`] per Beat
//! (the Beat-value computation lives only in TypeScript, in
//! `web/src/scoring/`). A Score record keeps the value of every Beat in its
//! Beat range, so the record can be rescored or graphed later.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What one Player sang in one Beat, independent of the Note and the
/// Difficulty.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum BeatValue {
    /// Too few readings passed the Mic threshold, or the Beat had none.
    NoVoice,
    /// Enough readings passed the Mic threshold, but too few were voiced:
    /// enough for a Rap note, not for a pitched Note.
    VoiceWithoutPitch,
    /// Enough readings were voiced; the lower median of their pitches.
    Pitch {
        /// A fractional MIDI note number (A4 = 69), always one of the Beat's
        /// actual readings.
        pitch: f64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(value: BeatValue) -> String {
        serde_json::to_string(&value).unwrap()
    }

    #[test]
    fn beat_values_on_the_wire() {
        assert_eq!(wire(BeatValue::NoVoice), r#"{"kind":"noVoice"}"#);
        assert_eq!(
            wire(BeatValue::VoiceWithoutPitch),
            r#"{"kind":"voiceWithoutPitch"}"#
        );
        assert_eq!(
            wire(BeatValue::Pitch { pitch: 57.25 }),
            r#"{"kind":"pitch","pitch":57.25}"#
        );
    }

    #[test]
    fn beat_values_round_trip() {
        for value in [
            BeatValue::NoVoice,
            BeatValue::VoiceWithoutPitch,
            BeatValue::Pitch {
                pitch: 61.123_456_789,
            },
        ] {
            let back: BeatValue = serde_json::from_str(&wire(value)).unwrap();
            assert_eq!(back, value);
        }
    }
}
