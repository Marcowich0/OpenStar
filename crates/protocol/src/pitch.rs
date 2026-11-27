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
use crate::bridge::BridgeId;

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
    /// One Local mic of an approved Mic bridge: the bridge (named by the id
    /// of its approval token) and the Local mic id of the channel, the same
    /// id a Line-up seat names (`MicKey::LocalMic`). Each Local mic syncs its
    /// own clock, so the Stage answers its pings naming this Mic.
    Bridge {
        bridge_id: BridgeId,
        local_mic_id: String,
    },
}

/// Which of a Mic bridge's Local mics a reading, ping or pong is for: one
/// hardware channel of one interface it offered in its hello (on the wire
/// as `localMic`). Only a bridge
/// sends it; a Phone, which is one Mic, never does.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BridgeLocalMic {
    /// The interface's `device.name`, as in its `BridgeInterface`.
    pub device_name: String,
    /// The hardware channel, from 0.
    pub channel: u32,
}

/// What the Stage receives from one Phone's Mic, for that Phone's mic
/// diagnostics: the Stage's answer ([`crate::ClientMessage::MicReport`]) to
/// a Phone's [`crate::ClientMessage::MicReportRequest`], relayed to that
/// Phone alone as [`crate::ServerMessage::MicReport`]. Figures over the last
/// two seconds, times in milliseconds on the Stage's clock. Never stored.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StageMicReport {
    /// Readings that reached the Stage in the last second.
    pub received_per_second: u32,
    /// From capture (the window centre) to arrival on the Stage: the median,
    /// the 95th percentile and the longest; `null` with no readings.
    pub arrival_p50_ms: Option<f64>,
    pub arrival_p95_ms: Option<f64>,
    pub arrival_max_ms: Option<f64>,
    /// The longest the Stage waited between two readings.
    pub largest_gap_ms: Option<f64>,
    /// The share (0 to 1) of readings whose trip took longer than the scoring
    /// window allows (the grace period, 300 ms): they are drawn but never
    /// scored.
    pub late_share: Option<f64>,
    /// The newest reading's loudness, dBFS.
    pub loudness_dbfs: Option<f64>,
    /// The Mic delay and effective Mic threshold (dBFS) the Stage would
    /// score this Phone with now.
    pub mic_delay_ms: f64,
    pub mic_threshold_dbfs: f64,
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
            let text = serde_json::to_string(&ClientMessage::PitchReading { reading: sent, local_mic: None }).unwrap();
            let ClientMessage::PitchReading { reading, .. } = serde_json::from_str(&text).unwrap() else {
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
    fn a_phones_messages_carry_no_bridge_local_mic_and_a_bridges_do() {
        let phone: ClientMessage =
            serde_json::from_str(r#"{"type":"clockPing","t0":1.5}"#).unwrap();
        assert_eq!(
            phone,
            ClientMessage::ClockPing {
                t0: 1.5,
                local_mic: None
            }
        );
        let to_phone = ServerMessage::ClockPong {
            t0: 1.0,
            ts: 2.0,
            epoch: 3.0,
            local_mic: None,
        };
        assert_eq!(
            serde_json::to_string(&to_phone).unwrap(),
            r#"{"type":"clockPong","t0":1.0,"ts":2.0,"epoch":3.0}"#
        );
        let bridge: ClientMessage = serde_json::from_str(
            r#"{"type":"clockPing","t0":1.5,"localMic":{"deviceName":"usb","channel":2}}"#,
        )
        .unwrap();
        assert_eq!(
            bridge,
            ClientMessage::ClockPing {
                t0: 1.5,
                local_mic: Some(BridgeLocalMic {
                    device_name: "usb".into(),
                    channel: 2
                }),
            }
        );
        let mic = MicId::Bridge {
            bridge_id: BridgeId("b1".into()),
            local_mic_id: "bridge:b1:usb:2".into(),
        };
        assert_eq!(
            serde_json::to_string(&mic).unwrap(),
            r#"{"kind":"bridge","bridgeId":"b1","localMicId":"bridge:b1:usb:2"}"#
        );
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
