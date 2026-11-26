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

/// Where a Local mic is read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum LocalMicSource {
    /// One channel of an input device the Stage browser reads itself. Its
    /// Local mic id is made from (`stage_browser`, `device_id`, `channel`).
    Browser {
        /// The Stage browser: a random id it keeps in its own storage.
        stage_browser: String,
        /// Chromium's `deviceId` of the input device.
        device_id: String,
        /// The device's label when it was last seen, for the default name
        /// and the label + channel fallback of id matching.
        label: String,
        /// 0 (Left, or a mono device's only channel) or 1 (Right).
        channel: u32,
        /// Whether the device gave two channels.
        stereo: bool,
    },
    /// One hardware channel of an interface a Mic bridge reads. Its Local
    /// mic id is made from (`bridge_id`, `device_name`, `channel`) by
    /// [`crate::bridge::bridge_local_mic_id`].
    Bridge {
        bridge_id: crate::bridge::BridgeId,
        /// The card's `device.name` (for `--wav`, the file name).
        device_name: String,
        /// The interface's name for people when it was last seen, for the
        /// default name "<label> · Input n".
        label: String,
        /// The hardware channel, from 0 (`AUXn` of the Pro Audio source).
        channel: u32,
    },
}

/// A Local mic the server keeps: its name and whether it is switched on.
/// A channel that matches none is new and switched off. Kept across Parties
/// and restarts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalMic {
    pub local_mic_id: String,
    pub source: LocalMicSource,
    /// The name the host gave it; empty shows the default name.
    pub name: String,
    pub switched_on: bool,
}

/// A switched-on Local mic as the Line-up offers it, in the Party snapshot:
/// its name and whether it can sing now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PartyLocalMic {
    pub local_mic_id: String,
    pub source: LocalMicSource,
    /// The name the host gave it; empty shows the default name.
    pub name: String,
    /// Plugged in (a Stage-browser device the Stage reports, a bridge
    /// channel whose bridge is open and offers it). An unplugged or
    /// closed-bridge Local mic is never free and is dimmed in Mic lists.
    pub present: bool,
}

/// Calibrate mics (#170): the one run, held by the server and told to every
/// connection ([`crate::ServerMessage::Calibration`]). It goes `choosing` (the
/// checklist) → `waiting` (each chosen Mic waiting or ready) → `tones` (the
/// Stage plays the tones; Mics not ready by then are left out) → `results`
/// (one row per Mic in the run) and ends when closed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CalibrationRun {
    pub phase: CalibrationPhase,
    /// In `choosing`, every Mic on the checklist with whether it is ticked;
    /// from `waiting` on, only the chosen Mics; from `tones` on, only those
    /// that take part.
    pub mics: Vec<CalibrationMic>,
}

/// Where a Calibration run is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CalibrationPhase {
    Choosing,
    Waiting,
    Tones,
    Results,
}

/// One Mic in a Calibration run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CalibrationMic {
    pub mic: MicKey,
    /// Ticked on the checklist (always true after `choosing`).
    pub chosen: bool,
    /// The Mic is listening: a Phone after its "I'm listening" tap.
    pub ready: bool,
    /// Its result, in `results`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub outcome: Option<CalibrationOutcome>,
}

/// One Mic's result row.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "result",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum CalibrationOutcome {
    /// Stored: its new Mic delay, in milliseconds.
    Calibrated { mic_delay_ms: f64 },
    /// It couldn't hear the Stage; it keeps its previous values.
    Failed,
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
