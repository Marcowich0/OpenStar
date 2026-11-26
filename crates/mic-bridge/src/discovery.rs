//! Which interfaces the bridge offers, worked out from what the sound
//! server says about its cards and sources (read over the PulseAudio
//! protocol by [`crate::pulse`]). Pure: no I/O.
//!
//! The rules (v1 spec #51, "Interface profile" and "Local mic ids"):
//!
//! - Only a card in the **Pro Audio** profile is read, through its Pro
//!   Audio source (`….pro-input-N`), whose `AUXn` is hardware channel *n*.
//!   A card in another profile is offered nothing, whichever it is (UCM
//!   "Direct" and "HiFi" included, and a profile with Pro Audio for one
//!   direction only); [`Discovered::not_pro_audio`] lists it for the
//!   profile message.
//! - Each interface is keyed on its card's `device.name`, which does not
//!   change with the profile (the source's node name does), so a Local mic
//!   keeps its id across a profile change. The source is mapped to its
//!   card through the card index.
//! - Two or more identical interfaces without a serial number (same USB
//!   id, same `device.serial`, which then carries no serial) are told apart
//!   by USB port: their key is the card name, without the `.2` WirePlumber
//!   adds to a repeated name in the order it found them, plus `@` and the
//!   USB port path. Swapping their ports swaps their Local mics.

use openstar_protocol::bridge::{BridgeInterface, NotProAudio};

/// What the sound server says about one card.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Card {
    /// The card's index, which its sources name.
    pub index: u32,
    /// `device.name`, for example `alsa_card.usb-Focusrite_…-00`.
    pub device_name: String,
    /// `device.description`, for people.
    pub description: String,
    /// `vendor:product` in lowercase hex, for a USB device.
    pub usb_id: Option<String>,
    /// `device.serial`: for USB, vendor, model and serial number (just
    /// vendor and model when the device has no serial number).
    pub serial: Option<String>,
    /// `device.bus-path`: the port it is plugged into.
    pub bus_path: Option<String>,
    /// The name of its active profile (`pro-audio` for Pro Audio).
    pub active_profile: Option<String>,
    /// The card's name on the sound server (what `pactl` takes).
    pub card_name: String,
    /// Its active profile's description, for people.
    pub profile_description: Option<String>,
}

/// What the sound server says about one source.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Source {
    /// Its node name, for example `alsa_input.usb-…-00.pro-input-0`.
    pub name: String,
    /// The index of its card, if it has one.
    pub card: Option<u32>,
    pub channels: u32,
    pub sample_rate: u32,
    /// The latency the sound server reports for it, in ms.
    pub latency_ms: Option<f64>,
    /// Whether it is the monitor of an output.
    pub monitor: bool,
}

/// One interface the bridge offers, and how to open it.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub interface: BridgeInterface,
    /// The node to capture from.
    pub node_name: String,
    pub sample_rate: u32,
    /// The input delay to report for every channel, in ms.
    pub latency_ms: Option<f64>,
}

/// What discovery found.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Discovered {
    /// The interfaces offered, by key.
    pub interfaces: Vec<Found>,
    /// Cards with an input that are in another profile: the profile
    /// message, each with Switch to Pro Audio.
    pub not_pro_audio: Vec<NotProAudio>,
}

/// The name of the Pro Audio profile.
pub const PRO_AUDIO: &str = "pro-audio";

/// The interfaces to offer from `cards` and `sources`.
pub fn discover(cards: &[Card], sources: &[Source]) -> Discovered {
    let inputs_of = |card: &Card| {
        let mut inputs: Vec<&Source> = sources
            .iter()
            .filter(|source| source.card == Some(card.index) && !source.monitor)
            .collect();
        inputs.sort_by(|a, b| a.name.cmp(&b.name));
        inputs
    };
    let mut found = Discovered::default();
    for card in cards {
        let inputs = inputs_of(card);
        if card.active_profile.as_deref() != Some(PRO_AUDIO) {
            if !inputs.is_empty() {
                found.not_pro_audio.push(NotProAudio {
                    device_name: card.device_name.clone(),
                    card_name: card.card_name.clone(),
                    label: card.description.clone(),
                    profile: profile_for_people(card),
                    switch_refused: false,
                });
            }
            continue;
        }
        let twin = is_twin(card, cards);
        let key = card_key(card, twin);
        let pro_inputs = inputs
            .into_iter()
            .filter_map(|source| Some((pro_input(&source.name)?, source)));
        for (number, (suffix, source)) in pro_inputs.enumerate() {
            let device_name = if number == 0 {
                key.clone()
            } else {
                format!("{key}#{suffix}")
            };
            found.interfaces.push(Found {
                interface: BridgeInterface {
                    device_name,
                    label: card.description.clone(),
                    channels: source.channels,
                    usb_id: card.usb_id.clone(),
                    twin,
                },
                node_name: source.name.clone(),
                sample_rate: source.sample_rate,
                latency_ms: source.latency_ms,
            });
        }
    }
    found
        .interfaces
        .sort_by(|a, b| a.interface.device_name.cmp(&b.interface.device_name));
    found
}

/// The active profile's name for people: its description, with a
/// matching "X Output + X Input" said once as "X" (so "Analog Surround
/// 2.1"); else its name; else nothing.
fn profile_for_people(card: &Card) -> String {
    let Some(description) = &card.profile_description else {
        return card.active_profile.clone().unwrap_or_default();
    };
    match description.split_once(" + ") {
        Some((output, input)) => {
            match (output.strip_suffix(" Output"), input.strip_suffix(" Input")) {
                (Some(a), Some(b)) if a == b => a.to_owned(),
                _ => description.clone(),
            }
        }
        None => description.clone(),
    }
}

/// `pro-input-N` when `node_name` is a Pro Audio source's, ignoring a
/// `.2` WirePlumber may add.
fn pro_input(node_name: &str) -> Option<&str> {
    let start = node_name.rfind(".pro-input-")? + 1;
    let rest = &node_name[start..];
    let end = rest
        .char_indices()
        .skip("pro-input-".len())
        .find(|(_, c)| !c.is_ascii_digit())
        .map_or(rest.len(), |(at, _)| at);
    (end > "pro-input-".len()).then(|| &rest[..end])
}

/// Whether another card is the same model with the same `device.serial`,
/// so neither has a serial number of its own.
fn is_twin(card: &Card, cards: &[Card]) -> bool {
    card.usb_id.is_some()
        && cards.iter().any(|other| {
            other.index != card.index && other.usb_id == card.usb_id && other.serial == card.serial
        })
}

/// The key of a card's interface: its `device.name`, or for a twin the
/// name without WirePlumber's `.N` and with its USB port.
fn card_key(card: &Card, twin: bool) -> String {
    match (&card.bus_path, twin) {
        (Some(port), true) => format!("{}@{port}", without_repeat_suffix(&card.device_name)),
        _ => card.device_name.clone(),
    }
}

/// `name` without a trailing `.N` (N digits).
fn without_repeat_suffix(name: &str) -> &str {
    match name.rsplit_once('.') {
        Some((base, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => base,
        _ => name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openstar_protocol::bridge::{BridgeId, bridge_local_mic_id};

    const SCARLETT: &str = "alsa_card.usb-Focusrite_Scarlett_4i4_4th_Gen_S4628DT4107338-00";
    const UMC: &str = "alsa_card.usb-BEHRINGER_UMC404HD_192k-00";

    fn scarlett(index: u32, profile: &str) -> Card {
        Card {
            index,
            device_name: SCARLETT.into(),
            description: "Scarlett 4i4 4th Gen".into(),
            usb_id: Some("1235:821a".into()),
            serial: Some("Focusrite_Scarlett_4i4_4th_Gen_S4628DT4107338".into()),
            bus_path: Some("pci-0000:00:14.0-usb-0:3:1.0".into()),
            active_profile: Some(profile.into()),
            card_name: format!("{SCARLETT}-card"),
            profile_description: None,
        }
    }

    fn umc(index: u32, device_name: &str, port: u32) -> Card {
        Card {
            index,
            device_name: device_name.into(),
            description: "UMC404HD 192k".into(),
            usb_id: Some("1397:0509".into()),
            serial: Some("BEHRINGER_UMC404HD_192k".into()),
            bus_path: Some(format!("pci-0000:00:14.0-usb-0:{port}:1.0")),
            active_profile: Some(PRO_AUDIO.into()),
            card_name: device_name.into(),
            profile_description: Some("Pro Audio".into()),
        }
    }

    fn source(name: &str, card: u32, channels: u32) -> Source {
        Source {
            name: name.into(),
            card: Some(card),
            channels,
            sample_rate: 48_000,
            latency_ms: Some(8.0),
            monitor: false,
        }
    }

    fn keys(found: &Discovered) -> Vec<&str> {
        found
            .interfaces
            .iter()
            .map(|f| f.interface.device_name.as_str())
            .collect()
    }

    #[test]
    fn a_card_in_pro_audio_offers_its_pro_audio_source_with_every_channel() {
        let found = discover(
            &[scarlett(42, PRO_AUDIO)],
            &[
                source("alsa_output.usb-Focusrite-00.pro-output-0", 42, 4),
                Source {
                    monitor: true,
                    ..source("alsa_output.usb-Focusrite-00.pro-output-0.monitor", 42, 4)
                },
                source("alsa_input.usb-Focusrite-00.pro-input-0", 42, 6),
            ],
        );
        assert_eq!(
            found.interfaces,
            vec![Found {
                interface: BridgeInterface {
                    device_name: SCARLETT.into(),
                    label: "Scarlett 4i4 4th Gen".into(),
                    channels: 6,
                    usb_id: Some("1235:821a".into()),
                    twin: false,
                },
                node_name: "alsa_input.usb-Focusrite-00.pro-input-0".into(),
                sample_rate: 48_000,
                latency_ms: Some(8.0),
            }]
        );
        assert_eq!(found.not_pro_audio, vec![]);
    }

    #[test]
    fn a_card_in_another_profile_offers_nothing_and_is_named_for_the_profile_message() {
        let mut card = scarlett(42, "output:analog-surround-21+input:analog-surround-21");
        card.profile_description =
            Some("Analog Surround 2.1 Output + Analog Surround 2.1 Input".into());
        card.description = "Scarlett 4i4".into();
        let found = discover(
            &[card],
            &[source(
                "alsa_input.usb-Focusrite-00.analog-surround-21",
                42,
                3,
            )],
        );
        assert_eq!(found.interfaces, vec![]);
        assert_eq!(
            found.not_pro_audio,
            vec![NotProAudio {
                device_name: SCARLETT.into(),
                card_name: format!("{SCARLETT}-card"),
                label: "Scarlett 4i4".into(),
                profile: "Analog Surround 2.1".into(),
                switch_refused: false,
            }]
        );
    }

    #[test]
    fn a_profile_is_named_by_its_description_with_a_matching_output_and_input_said_once() {
        let named = |description: Option<&str>| {
            let mut card = scarlett(1, "output:x+input:y");
            card.profile_description = description.map(str::to_owned);
            profile_for_people(&card)
        };
        assert_eq!(
            named(Some(
                "Analog Surround 2.1 Output + Analog Surround 2.1 Input"
            )),
            "Analog Surround 2.1"
        );
        assert_eq!(
            named(Some("Analog Stereo Output + Analog Surround 4.0 Input")),
            "Analog Stereo Output + Analog Surround 4.0 Input"
        );
        assert_eq!(named(Some("Analog Stereo Input")), "Analog Stereo Input");
        assert_eq!(named(None), "output:x+input:y");
    }

    #[test]
    fn ucm_direct_hifi_and_partial_profiles_are_not_read() {
        // UCM "Direct", UCM "HiFi" (inputs split into mono sources), and a
        // profile that names Pro Audio for one direction only: each is a
        // profile message, and no channel of the card is offered.
        for (profile, sources) in [
            (
                "Direct",
                vec![source("alsa_input.usb-X-00.Direct__hw_X__source", 42, 4)],
            ),
            (
                "HiFi",
                vec![
                    source("alsa_input.usb-X-00.HiFi__Mic1__source", 42, 1),
                    source("alsa_input.usb-X-00.HiFi__Mic2__source", 42, 1),
                ],
            ),
            (
                "output:pro-audio+input:analog-stereo",
                vec![source("alsa_input.usb-X-00.pro-input-0", 42, 2)],
            ),
        ] {
            let found = discover(&[scarlett(42, profile)], &sources);
            assert_eq!(found.interfaces, vec![], "{profile} was read");
            assert_eq!(found.not_pro_audio.len(), 1, "{profile}");
            assert_eq!(found.not_pro_audio[0].profile, profile);
        }
    }

    #[test]
    fn a_card_with_no_profile_active_or_no_input_is_said_only_when_it_has_an_input() {
        let mut off = scarlett(42, "off");
        off.active_profile = None;
        let found = discover(
            &[off],
            &[source("alsa_input.usb-X-00.analog-stereo", 42, 2)],
        );
        assert_eq!(found.not_pro_audio[0].profile, "");
        // An output-only card in another profile says nothing.
        let found = discover(&[scarlett(42, "output:analog-stereo")], &[]);
        assert_eq!(found.not_pro_audio, vec![]);
    }

    #[test]
    fn a_bridge_local_mic_id_is_unchanged_across_a_profile_change() {
        let bridge = BridgeId("sha-of-the-token".into());
        let id_of_channel_2 = |found: &Discovered| {
            let interface = &found.interfaces[0].interface;
            bridge_local_mic_id(&bridge, &interface.device_name, 2)
        };
        // Before: Pro Audio, card 42.
        let before = discover(
            &[scarlett(42, PRO_AUDIO)],
            &[source("alsa_input.usb-Focusrite-00.pro-input-0", 42, 6)],
        );
        // Switched away and back: a new card index and a renamed node.
        let after = discover(
            &[scarlett(57, PRO_AUDIO)],
            &[source("alsa_input.usb-Focusrite-00.pro-input-0.2", 57, 6)],
        );
        assert_eq!(id_of_channel_2(&before), id_of_channel_2(&after));
        assert_eq!(
            id_of_channel_2(&before),
            format!("bridge:sha-of-the-token:{SCARLETT}:2")
        );
    }

    #[test]
    fn serial_less_twins_are_told_apart_by_usb_port() {
        let sources = [
            source("alsa_input.usb-BEHRINGER-00.pro-input-0", 1, 4),
            source("alsa_input.usb-BEHRINGER-00.pro-input-0.2", 2, 4),
        ];
        let found = discover(&[umc(1, UMC, 1), umc(2, &format!("{UMC}.2"), 2)], &sources);
        let port_1 = format!("{UMC}@pci-0000:00:14.0-usb-0:1:1.0");
        let port_2 = format!("{UMC}@pci-0000:00:14.0-usb-0:2:1.0");
        assert_eq!(keys(&found), vec![port_1.as_str(), port_2.as_str()]);
        assert!(found.interfaces.iter().all(|f| f.interface.twin));

        // Found in the other order (so WirePlumber's ".2" moved): each port
        // keeps its key.
        let swapped = discover(&[umc(1, UMC, 2), umc(2, &format!("{UMC}.2"), 1)], &sources);
        let mut swapped_keys = keys(&swapped);
        swapped_keys.sort_unstable();
        assert_eq!(swapped_keys, vec![port_1.as_str(), port_2.as_str()]);
        assert_eq!(swapped.interfaces[0].node_name, sources[1].name);
    }

    #[test]
    fn a_lone_serial_less_interface_is_keyed_on_its_card_name_alone() {
        let found = discover(
            &[umc(1, UMC, 1)],
            &[source("alsa_input.usb-BEHRINGER-00.pro-input-0", 1, 4)],
        );
        assert_eq!(keys(&found), vec![UMC]);
        assert!(!found.interfaces[0].interface.twin);
    }

    #[test]
    fn interfaces_with_serial_numbers_are_never_twins() {
        let mut other = scarlett(43, PRO_AUDIO);
        other.device_name = format!("{SCARLETT}-other");
        other.serial = Some("Focusrite_Scarlett_4i4_4th_Gen_S9999".into());
        let found = discover(
            &[scarlett(42, PRO_AUDIO), other.clone()],
            &[
                source("alsa_input.a.pro-input-0", 42, 6),
                source("alsa_input.b.pro-input-0", 43, 6),
            ],
        );
        assert_eq!(keys(&found), vec![SCARLETT, other.device_name.as_str()]);
        assert!(found.interfaces.iter().all(|f| !f.interface.twin));
    }

    #[test]
    fn a_second_pro_audio_source_of_one_card_gets_its_own_key() {
        let found = discover(
            &[scarlett(42, PRO_AUDIO)],
            &[
                source("alsa_input.x.pro-input-1", 42, 2),
                source("alsa_input.x.pro-input-0", 42, 6),
            ],
        );
        assert_eq!(
            keys(&found),
            vec![SCARLETT.to_owned(), format!("{SCARLETT}#pro-input-1")]
        );
        assert_eq!(found.interfaces[0].interface.channels, 6);
    }
}
