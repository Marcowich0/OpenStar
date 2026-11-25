//! What the server keeps per (Mic, Stage output): Mic delays, bleed levels
//! and Mic thresholds.
//!
//! The Stage computes every value (Calibration analysis, the + 6 dB margin,
//! the conversion to the reference volume) in TypeScript and sends finished
//! values; the server only keeps them. Writes are WebSocket messages
//! accepted only from the active Stage
//! ([`crate::ClientMessage::StoreCalibration`],
//! [`crate::ClientMessage::SetMicThreshold`]); reads are
//! `GET /api/mic-settings?stageOutput=…`. After every accepted write every
//! browser gets [`crate::ChangeTopic::MicSettings`].

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Names a Mic for its stored values: a Phone by its Phone id, a Local mic
/// by its Local mic id. Both are kept as the browser sends them.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum MicKey {
    /// A Phone: values are per Phone, not per Profile.
    Phone { phone_id: String },
    /// A Local mic, by its Local mic id.
    LocalMic { local_mic_id: String },
}

/// One Mic's successful Calibration result, as the Stage computed it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CalibrationResult {
    pub mic: MicKey,
    /// The Mic delay, in milliseconds.
    pub mic_delay_ms: f64,
    /// The bleed level, in dBFS at the reference volume.
    pub bleed_level_dbfs: f64,
    /// For a Local mic: its Mic threshold (bleed level + 6 dB), in dBFS at
    /// the reference volume. Stored as set by Calibration. Left out, the
    /// stored Mic threshold stays as it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mic_threshold_dbfs: Option<f64>,
}

/// What last set a stored Mic threshold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ThresholdSetBy {
    Calibration,
    Hand,
}

/// A Mic's Calibration values at one Stage output.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StoredCalibration {
    pub mic_delay_ms: f64,
    /// At the reference volume.
    pub bleed_level_dbfs: f64,
}

/// A stored Mic threshold, last write wins.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StoredMicThreshold {
    /// At the reference volume.
    pub reference_dbfs: f64,
    pub set_by: ThresholdSetBy,
}

/// What the server keeps for one Mic at one Stage output.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StoredMicSettings {
    /// Present exactly when the Mic is calibrated at this Stage output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub calibration: Option<StoredCalibration>,
    /// The Mic threshold, if one was stored. v1 stores one only for Local
    /// mics; Phones ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mic_threshold: Option<StoredMicThreshold>,
}

/// One Mic's values at a Stage output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MicSettingsEntry {
    pub mic: MicKey,
    pub settings: StoredMicSettings,
}

/// Query of `GET /api/mic-settings`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MicSettingsQuery {
    /// The Stage output key: the default output's label without "Default - ".
    pub stage_output: String,
}

/// Body of `GET /api/mic-settings`: every Mic's values at one Stage output.
/// An output nothing was stored for has no entries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StageOutputMicSettings {
    pub stage_output: String,
    pub mics: Vec<MicSettingsEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mic_keys_are_tagged_by_kind() {
        let key = MicKey::LocalMic {
            local_mic_id: "browser:abc:0".into(),
        };
        assert_eq!(
            serde_json::to_string(&key).unwrap(),
            r#"{"kind":"localMic","localMicId":"browser:abc:0"}"#
        );
    }

    #[test]
    fn stored_settings_leave_out_what_is_not_stored() {
        let settings = StoredMicSettings {
            calibration: None,
            mic_threshold: Some(StoredMicThreshold {
                reference_dbfs: -37.5,
                set_by: ThresholdSetBy::Hand,
            }),
        };
        assert_eq!(
            serde_json::to_string(&settings).unwrap(),
            r#"{"micThreshold":{"referenceDbfs":-37.5,"setBy":"hand"}}"#
        );
    }
}
