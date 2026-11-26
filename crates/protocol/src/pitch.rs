//! Pitch readings and clock sync on the wire.
//!
//! A Phone sends each [`PitchReading`] as a
//! [`crate::ClientMessage::PitchReading`] over its one WebSocket. The server
//! relays it, values untouched, to the current Stage as a
//! [`crate::ServerMessage::PitchReading`] tagged with the [`MicId`] it came
//! from. Clock sync uses the same connection: the sender's
//! [`crate::ClientMessage::ClockPing`] reaches the Stage as a
//! [`crate::ServerMessage::ClockPing`], and the Stage's
//! [`crate::ClientMessage::ClockPong`] goes back to that sender alone as a
//! [`crate::ServerMessage::ClockPong`]. Raw readings are never stored.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::PhoneId;

/// One measurement of what a Mic heard at one moment.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PitchReading {
    /// The centre of the detector window, on the Stage's clock (the Stage
    /// page's `performance.now()`), in milliseconds.
    pub capture_ms: f64,
    /// A fractional MIDI note number (A4 = 69), or `null` when the detector
    /// found no frequency.
    pub pitch: Option<f64>,
    /// The detector's clarity, 0 to 1.
    pub clarity: f64,
    /// The RMS of the detector window in dBFS; digital silence is −120.
    pub loudness: f64,
}

/// Names the Mic a relayed message came from. The Stage uses it to tell
/// Mics apart and to address a [`crate::ClientMessage::ClockPong`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum MicId {
    /// A Phone, named by the Phone id its connection presented in
    /// [`crate::ClientMessage::Hello`]: the same id a Line-up seat names
    /// (`MicKey::Phone`), so the Stage can match readings to their seat,
    /// and the same Mic again after the Phone reconnects.
    Phone { phone_id: PhoneId },
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::{ClientMessage, ServerMessage};

    fn finite() -> impl Strategy<Value = f64> {
        any::<f64>().prop_filter("JSON has only finite numbers", |x| x.is_finite())
    }

    proptest! {
        /// What the relay does to a reading: parse the Phone's JSON, wrap it
        /// for the Stage, write JSON again. Every value comes out bit for bit.
        #[test]
        fn a_relayed_reading_keeps_every_value_exactly(
            capture_ms in finite(),
            pitch in proptest::option::of(finite()),
            clarity in finite(),
            loudness in finite(),
        ) {
            let sent = PitchReading { capture_ms, pitch, clarity, loudness };
            let text = serde_json::to_string(&ClientMessage::PitchReading { reading: sent }).unwrap();
            let ClientMessage::PitchReading { reading } = serde_json::from_str(&text).unwrap() else {
                panic!("not a reading");
            };
            let relayed = serde_json::to_string(&ServerMessage::PitchReading {
                mic: MicId::Phone { phone_id: PhoneId("p1".into()) },
                reading,
            })
            .unwrap();
            let ServerMessage::PitchReading { reading: received, .. } =
                serde_json::from_str(&relayed).unwrap()
            else {
                panic!("not a reading");
            };
            let bits = |r: &PitchReading| {
                (r.capture_ms.to_bits(), r.pitch.map(f64::to_bits), r.clarity.to_bits(), r.loudness.to_bits())
            };
            prop_assert_eq!(bits(&received), bits(&sent));
        }
    }

    #[test]
    fn a_reading_is_camel_case_with_a_null_pitch_when_unvoiced() {
        let reading = PitchReading {
            capture_ms: 1.5,
            pitch: None,
            clarity: 0.25,
            loudness: -120.0,
        };
        assert_eq!(
            serde_json::to_string(&ServerMessage::PitchReading {
                mic: MicId::Phone {
                    phone_id: PhoneId("phone-3".into())
                },
                reading,
            })
            .unwrap(),
            r#"{"type":"pitchReading","mic":{"kind":"phone","phoneId":"phone-3"},"reading":{"captureMs":1.5,"pitch":null,"clarity":0.25,"loudness":-120.0}}"#
        );
    }
}
