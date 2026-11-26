//! The Mic bridge: what it tells the server when it joins, what the server
//! tells it back, and what the Stage reads about bridges.
//!
//! A bridge connects on its own WebSocket, `/ws/bridge`, and sends
//! [`crate::ClientMessage::BridgeHello`] first. Without a valid approval
//! token it waits for approval with a 4-digit code
//! ([`crate::ServerMessage::BridgeWaiting`]); the Stage approves it
//! ([`crate::ClientMessage::ApproveBridge`], no Admin PIN) and the bridge is
//! handed its token once ([`crate::ServerMessage::BridgeApproved`]). With a
//! valid token it is connected at once ([`crate::ServerMessage::BridgeConnected`]).
//!
//! The token is the bridge's identity. The server keeps only its SHA-256,
//! the public [`BridgeId`], which names the bridge everywhere else (its
//! Local mic ids included), so nobody but the bridge ever sees the token.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::mics::LocalMicSource;

/// Names an approved Mic bridge: the lowercase hex SHA-256 of its approval
/// token.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BridgeId(pub String);

/// Names a bridge waiting for approval, while its connection is open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BridgeRequestId(pub u32);

/// One audio interface a bridge reads (for `--wav`, the WAV file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BridgeInterface {
    /// The card's `device.name`, which does not change with the profile
    /// (for `--wav`, the file name). Part of each Local mic's id.
    pub device_name: String,
    /// The interface's name for people (for `--wav`, the file name), used
    /// in default names.
    pub label: String,
    /// How many hardware channels it has: channels `0..channels`.
    pub channels: u32,
    /// Its USB id, `vendor:product` in lowercase hex (`1235:821a`), when it
    /// is a USB device: what the known-models table ([`loopback_number`])
    /// is keyed on. Left out for `--wav`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub usb_id: Option<String>,
    /// Whether it is one of two or more identical interfaces without a
    /// serial number on this bridge. Those are told apart by USB port (their
    /// `device_name` carries it), so swapping their ports swaps their Local
    /// mics; the Mics screen says so.
    #[serde(default)]
    pub twin: bool,
}

/// The known-models table: for an interface with USB id `usb_id`, which
/// loopback channel hardware channel `channel` (from 0) is, counting from
/// one. Nothing marks a channel as loopback, so this small built-in table is
/// all there is; channels in it are named "<device> · Loopback n", listed
/// last in their group, and start switched off like every new channel.
pub fn loopback_number(usb_id: Option<&str>, channel: u32) -> Option<u32> {
    /// (USB id, the loopback channels in order, from 0).
    const KNOWN_MODELS: &[(&str, &[u32])] = &[
        // Focusrite Scarlett 4i4 4th Gen: inputs 1-4, then the loopback
        // pair on channels 5-6 (`AUX4`, `AUX5`).
        ("1235:821a", &[4, 5]),
    ];
    let (_, loopback) = KNOWN_MODELS.iter().find(|(id, _)| Some(*id) == usb_id)?;
    let position = loopback.iter().position(|c| *c == channel)?;
    u32::try_from(position).ok().map(|n| n + 1)
}

/// The Local mic id of a bridge's hardware channel: made from (bridge,
/// `device.name`, hardware channel), so it survives a profile change. The
/// server makes it; the Stage and the bridge take it as given.
pub fn bridge_local_mic_id(bridge: &BridgeId, device_name: &str, channel: u32) -> String {
    format!("bridge:{}:{device_name}:{channel}", bridge.0)
}

/// What the server tells a bridge about one of its channels: whether it is
/// switched on and its name (empty: the bridge shows the default name).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BridgeChannelSettings {
    pub device_name: String,
    pub channel: u32,
    pub local_mic_id: String,
    pub switched_on: bool,
    pub name: String,
}

/// A channel's meter level, as a bridge measured it over the last tenth of
/// a second.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BridgeLevel {
    pub device_name: String,
    pub channel: u32,
    /// RMS level in dBFS: at most 0, and −100 for silence.
    pub level_dbfs: f64,
    /// Every sample of the interval was exactly 0 (not quiet noise): the
    /// "sends no sound" warning's input.
    #[serde(default)]
    pub digital_silence: bool,
}

/// A channel's input delay, as a bridge's capture backend reported it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BridgeInputDelay {
    pub device_name: String,
    pub channel: u32,
    /// In ms, at least 0.
    pub delay_ms: f64,
}

/// A Local mic's meter level, as the server relays it to the Stage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalMicLevel {
    pub local_mic_id: String,
    pub level_dbfs: f64,
    /// As [`BridgeLevel::digital_silence`].
    pub digital_silence: bool,
}

/// One hardware channel of an open bridge, as the Mics screen lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BridgeChannel {
    pub local_mic_id: String,
    /// Always the `bridge` kind.
    pub source: LocalMicSource,
    /// The input delay the bridge's capture backend reported for it, in
    /// ms: the default Mic delay of an uncalibrated Local mic. Left out
    /// when none was reported (always, in `--wav` mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reported_input_delay_ms: Option<f64>,
}

/// An approved Mic bridge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MicBridge {
    pub bridge_id: BridgeId,
    /// The name of the bridge's computer, as it last said.
    pub host_name: String,
    /// Whether the bridge is connected now; a closed bridge stays approved.
    pub open: bool,
    /// While open: every hardware channel it offers, interface by
    /// interface. Empty while closed (its kept Local mics are in
    /// `GET /api/local-mics`).
    pub channels: Vec<BridgeChannel>,
    /// While open: the interfaces it offers, as it said in its hello.
    /// Empty while closed.
    pub interfaces: Vec<BridgeInterface>,
}

/// A bridge waiting for approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BridgeRequest {
    pub request_id: BridgeRequestId,
    pub host_name: String,
    /// The 4-digit code the bridge shows too.
    pub code: String,
}

/// Body of `GET /api/mic-bridges`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MicBridges {
    /// Approved bridges, in order of approval.
    pub bridges: Vec<MicBridge>,
    /// Bridges waiting for approval ("New bridges"), oldest first.
    pub requests: Vec<BridgeRequest>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bridge_local_mic_id_is_made_of_bridge_device_and_channel() {
        assert_eq!(
            bridge_local_mic_id(&BridgeId("ab12".into()), "alsa_card.usb-X-00", 3),
            "bridge:ab12:alsa_card.usb-X-00:3"
        );
    }
}

#[cfg(test)]
mod known_model_tests {
    use super::*;

    #[test]
    fn the_scarlett_4i4_4th_gen_has_loopback_on_channels_5_and_6() {
        assert_eq!(loopback_number(Some("1235:821a"), 3), None);
        assert_eq!(loopback_number(Some("1235:821a"), 4), Some(1));
        assert_eq!(loopback_number(Some("1235:821a"), 5), Some(2));
    }

    #[test]
    fn an_unknown_model_or_no_usb_id_has_no_loopback() {
        assert_eq!(loopback_number(Some("1397:0509"), 4), None);
        assert_eq!(loopback_number(None, 4), None);
    }
}
