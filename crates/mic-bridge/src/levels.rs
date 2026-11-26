//! Which interfaces the bridge opens and which channels it meters (v1 spec
//! #51, by the same rule as the Stage browser): every interface with at
//! least one switched-on channel is open; one with no switched-on channel
//! only while the Stage's Mics screen is open. Levels go to the server ten
//! times a second for the switched-on channels, and for every channel while
//! the Mics screen is open.
//!
//! [`Metering`] keeps what the server last said; it is pure, so the rule is
//! tested here without a socket or audio.

use std::collections::HashSet;
use std::time::Duration;

use openstar_protocol::bridge::{BridgeChannelSettings, BridgeInterface, BridgeLevel};

/// How often levels are sent: 10 Hz.
pub const LEVEL_INTERVAL: Duration = Duration::from_millis(100);

/// The level of silence, in dBFS (as the Stage browser's meters).
pub const SILENCE_DBFS: f64 = -100.0;

/// What the server last told the bridge about its channels and the Mics
/// screen. Before the first [`crate::client::Effect`] nothing is switched on
/// and the Mics screen counts as closed.
#[derive(Debug, Clone, Default)]
pub struct Metering {
    switched_on: HashSet<(String, u32)>,
    mics_screen_open: bool,
}

impl Metering {
    /// The server sent each channel's settings.
    pub fn set_channels(&mut self, channels: &[BridgeChannelSettings]) {
        self.switched_on = channels
            .iter()
            .filter(|c| c.switched_on)
            .map(|c| (c.device_name.clone(), c.channel))
            .collect();
    }

    /// The server said whether the Stage's Mics screen is open.
    pub fn set_mics_screen_open(&mut self, open: bool) {
        self.mics_screen_open = open;
    }

    fn is_on(&self, device_name: &str, channel: u32) -> bool {
        self.switched_on
            .contains(&(device_name.to_owned(), channel))
    }

    /// Whether `interface` should be open now.
    pub fn is_open(&self, interface: &BridgeInterface) -> bool {
        self.mics_screen_open
            || (0..interface.channels).any(|channel| self.is_on(&interface.device_name, channel))
    }

    /// The channels of `interface` whose levels are sent: every one while
    /// the Mics screen is open, otherwise the switched-on ones.
    pub fn metered(&self, interface: &BridgeInterface) -> Vec<u32> {
        (0..interface.channels)
            .filter(|&channel| self.mics_screen_open || self.is_on(&interface.device_name, channel))
            .collect()
    }

    /// The levels to send for `interface`, given the level of each of its
    /// channels (`levels[n]` = channel n) over the last interval.
    /// `zeros[n]` says whether channel n was exact digital silence.
    pub fn levels_to_send(
        &self,
        interface: &BridgeInterface,
        levels: &[f64],
        zeros: &[bool],
    ) -> Vec<BridgeLevel> {
        self.metered(interface)
            .into_iter()
            .filter_map(|channel| {
                let level_dbfs = *levels.get(channel as usize)?;
                Some(BridgeLevel {
                    device_name: interface.device_name.clone(),
                    channel,
                    level_dbfs,
                    digital_silence: zeros.get(channel as usize).copied().unwrap_or(false),
                })
            })
            .collect()
    }
}

/// Whether each channel of `interleaved` frames of `channels` channels is
/// exact digital silence: at least one frame, every sample exactly 0 (v1
/// spec #51, "sends no sound"). Quiet noise is not, however quiet.
pub fn channel_digital_silence(interleaved: &[f32], channels: usize) -> Vec<bool> {
    if channels == 0 {
        return Vec::new();
    }
    let frames = interleaved.len() / channels;
    (0..channels)
        .map(|channel| {
            frames > 0
                && interleaved
                    .iter()
                    .skip(channel)
                    .step_by(channels)
                    .take(frames)
                    .all(|&s| s == 0.0)
        })
        .collect()
}

/// The RMS level of each channel of `interleaved` frames of `channels`
/// channels, in dBFS, at least [`SILENCE_DBFS`].
pub fn channel_levels_dbfs(interleaved: &[f32], channels: usize) -> Vec<f64> {
    if channels == 0 {
        return Vec::new();
    }
    let frames = interleaved.len() / channels;
    (0..channels)
        .map(|channel| {
            if frames == 0 {
                return SILENCE_DBFS;
            }
            let sum_sq: f64 = interleaved
                .iter()
                .skip(channel)
                .step_by(channels)
                .take(frames)
                .map(|&s| f64::from(s) * f64::from(s))
                .sum();
            let rms = (sum_sq / frames as f64).sqrt();
            if rms <= 0.0 {
                SILENCE_DBFS
            } else {
                (20.0 * rms.log10()).clamp(SILENCE_DBFS, 0.0)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn interface(device_name: &str, channels: u32) -> BridgeInterface {
        BridgeInterface {
            device_name: device_name.into(),
            label: device_name.into(),
            channels,
            usb_id: None,
            twin: false,
        }
    }

    fn settings(device_name: &str, channel: u32, switched_on: bool) -> BridgeChannelSettings {
        BridgeChannelSettings {
            device_name: device_name.into(),
            channel,
            local_mic_id: format!("bridge:b:{device_name}:{channel}"),
            switched_on,
            name: String::new(),
        }
    }

    /// Two interfaces: channel 2 of the Scarlett is switched on, nothing
    /// of the dongle.
    fn metering(mics_screen_open: bool) -> (Metering, BridgeInterface, BridgeInterface) {
        let mut metering = Metering::default();
        metering.set_channels(&[
            settings("scarlett", 0, false),
            settings("scarlett", 2, true),
            settings("dongle", 0, false),
            settings("dongle", 1, false),
        ]);
        metering.set_mics_screen_open(mics_screen_open);
        (metering, interface("scarlett", 4), interface("dongle", 2))
    }

    #[test]
    fn before_the_server_says_anything_nothing_is_open_or_metered() {
        let metering = Metering::default();
        assert!(!metering.is_open(&interface("scarlett", 4)));
        assert_eq!(
            metering.metered(&interface("scarlett", 4)),
            Vec::<u32>::new()
        );
    }

    #[test]
    fn an_interface_with_a_switched_on_channel_is_open_the_rest_only_with_the_mics_screen() {
        let (closed, scarlett, dongle) = metering(false);
        assert!(closed.is_open(&scarlett));
        assert!(!closed.is_open(&dongle));

        let (open, scarlett, dongle) = metering(true);
        assert!(open.is_open(&scarlett));
        assert!(open.is_open(&dongle));
    }

    #[test]
    fn switching_the_last_channel_off_closes_the_interface() {
        let (mut metering, scarlett, _) = metering(false);
        metering.set_channels(&[settings("scarlett", 2, false)]);
        assert!(!metering.is_open(&scarlett));
    }

    #[test]
    fn levels_are_sent_for_switched_on_channels_and_for_all_while_the_mics_screen_is_open() {
        let (closed, scarlett, dongle) = metering(false);
        assert_eq!(closed.metered(&scarlett), vec![2]);
        assert_eq!(closed.metered(&dongle), Vec::<u32>::new());

        let (open, scarlett, dongle) = metering(true);
        assert_eq!(open.metered(&scarlett), vec![0, 1, 2, 3]);
        assert_eq!(open.metered(&dongle), vec![0, 1]);
    }

    #[test]
    fn the_levels_sent_name_their_interface_and_channel() {
        let (closed, scarlett, _) = metering(false);
        assert_eq!(
            closed.levels_to_send(
                &scarlett,
                &[-10.0, -20.0, -30.0, -40.0],
                &[false, false, true, false]
            ),
            vec![BridgeLevel {
                device_name: "scarlett".into(),
                channel: 2,
                level_dbfs: -30.0,
                digital_silence: true,
            }]
        );
    }

    #[test]
    fn only_exact_zeros_are_digital_silence_never_quiet_noise() {
        // Channel 0: exact zeros; channel 1: quiet noise far below the
        // meter's floor (about −150 dBFS); channel 2: zeros but one sample.
        let frames: Vec<f32> = (0..480)
            .flat_map(|i| {
                let sign = if i % 2 == 0 { 1.0 } else { -1.0 };
                [0.0, sign * 3e-8, if i == 300 { 1e-9 } else { 0.0 }]
            })
            .collect();
        assert_eq!(
            channel_digital_silence(&frames, 3),
            vec![true, false, false]
        );
        assert_eq!(channel_levels_dbfs(&frames, 3)[1], SILENCE_DBFS);
        assert_eq!(channel_digital_silence(&[], 2), vec![false; 2]);
    }

    #[test]
    fn channel_levels_are_rms_dbfs_with_silence_at_the_floor() {
        // Channel 0: a full-scale square wave (0 dBFS); channel 1: half
        // amplitude (−6.02 dBFS); channel 2: silence.
        let frames: Vec<f32> = (0..480)
            .flat_map(|i| {
                let sign = if i % 2 == 0 { 1.0 } else { -1.0 };
                [sign, sign * 0.5, 0.0]
            })
            .collect();
        let levels = channel_levels_dbfs(&frames, 3);
        assert!(levels[0].abs() < 1e-9, "{levels:?}");
        assert!((levels[1] - -6.0206).abs() < 1e-3, "{levels:?}");
        assert_eq!(levels[2], SILENCE_DBFS);
        assert_eq!(channel_levels_dbfs(&[], 2), vec![SILENCE_DBFS; 2]);
    }
}
