//! The switched-on Local mics as the Line-up sees them: in Mics-screen
//! order, each with whether it is present now. Free of the task and the
//! database: the task hands in the kept Local mics and what the Stage and
//! the Mic bridges report.
//!
//! A Local mic is *free* for the Mic prefill when it is switched on, not
//! seated and present: a Stage-browser Local mic while the active Stage
//! reports its device plugged in, a bridge Local mic while its bridge is
//! open and offers that channel. "Not seated" is the prefill's own rule
//! (`line_up::prefill_mic` skips Mics another seat holds).

use std::cmp::Ordering;
use std::collections::HashSet;

use openstar_protocol::bridge::BridgeId;
use openstar_protocol::mics::{LocalMic, LocalMicSource, PartyLocalMic};

/// What says a Local mic is present now.
#[derive(Debug, Default, Clone)]
pub struct Presence {
    /// The Stage-browser Local mics the active Stage reports present.
    pub browser: HashSet<String>,
    /// The bridge Local mics that open Mic bridges offer now.
    pub bridge_channels: HashSet<String>,
    /// Approved Mic bridges, in order of approval: their groups' order on
    /// the Mics screen.
    pub bridges: Vec<BridgeId>,
}

/// Every switched-on Local mic of `kept`, in Mics-screen order (This
/// browser first, then each bridge by approval; devices by name, channels
/// by number), with whether it is present.
pub fn party_local_mics(kept: &[LocalMic], presence: &Presence) -> Vec<PartyLocalMic> {
    let mut on: Vec<&LocalMic> = kept.iter().filter(|mic| mic.switched_on).collect();
    on.sort_by(|a, b| mics_screen_order(&a.source, &b.source, &presence.bridges));
    on.into_iter()
        .map(|mic| PartyLocalMic {
            local_mic_id: mic.local_mic_id.clone(),
            source: mic.source.clone(),
            name: mic.name.clone(),
            present: match mic.source {
                LocalMicSource::Browser { .. } => presence.browser.contains(&mic.local_mic_id),
                LocalMicSource::Bridge { .. } => {
                    presence.bridge_channels.contains(&mic.local_mic_id)
                }
            },
        })
        .collect()
}

/// The present ones of `list`, in its order: what the Mic prefill and
/// `setMic` may choose.
pub fn present_ids(list: &[PartyLocalMic]) -> Vec<String> {
    list.iter()
        .filter(|mic| mic.present)
        .map(|mic| mic.local_mic_id.clone())
        .collect()
}

/// The Mics screen's order of two Local mics' sources.
fn mics_screen_order(a: &LocalMicSource, b: &LocalMicSource, bridges: &[BridgeId]) -> Ordering {
    // A bridge that is no longer approved sorts after every approved one.
    let group = |source: &LocalMicSource| match source {
        LocalMicSource::Browser { .. } => 0,
        LocalMicSource::Bridge { bridge_id, .. } => {
            1 + bridges
                .iter()
                .position(|id| id == bridge_id)
                .unwrap_or(bridges.len())
        }
    };
    let within = |source: &LocalMicSource| match source {
        LocalMicSource::Browser {
            stage_browser,
            device_id,
            label,
            channel,
            ..
        } => (
            label.clone(),
            stage_browser.clone(),
            device_id.clone(),
            *channel,
        ),
        LocalMicSource::Bridge {
            bridge_id,
            device_name,
            label,
            channel,
        } => (
            label.clone(),
            bridge_id.0.clone(),
            device_name.clone(),
            *channel,
        ),
    };
    group(a)
        .cmp(&group(b))
        .then_with(|| within(a).cmp(&within(b)))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use openstar_protocol::bridge::bridge_local_mic_id;
    use openstar_protocol::mics::MicKey;
    use openstar_protocol::{
        Identity, JoinCode, PartyId, PartyMember, PartyMemberId, PartySnapshot, Request, RequestId,
        RequestKind, StageId,
    };

    use super::*;
    use crate::live::line_up::{MicChoices, prefill};

    fn browser(device: &str, label: &str, channel: u32, on: bool) -> LocalMic {
        LocalMic {
            local_mic_id: format!("browser:stage:{device}:{channel}"),
            source: LocalMicSource::Browser {
                stage_browser: "stage".into(),
                device_id: device.into(),
                label: label.into(),
                channel,
                stereo: true,
            },
            name: String::new(),
            switched_on: on,
        }
    }

    fn bridged(bridge: &str, device: &str, label: &str, channel: u32, on: bool) -> LocalMic {
        let bridge_id = BridgeId(bridge.into());
        LocalMic {
            local_mic_id: bridge_local_mic_id(&bridge_id, device, channel),
            source: LocalMicSource::Bridge {
                bridge_id,
                device_name: device.into(),
                label: label.into(),
                channel,
            },
            name: String::new(),
            switched_on: on,
        }
    }

    fn ids(list: &[PartyLocalMic]) -> Vec<&str> {
        list.iter().map(|mic| mic.local_mic_id.as_str()).collect()
    }

    fn set(mics: &[&LocalMic]) -> HashSet<String> {
        mics.iter().map(|mic| mic.local_mic_id.clone()).collect()
    }

    #[test]
    fn only_switched_on_local_mics_are_listed() {
        let on = browser("usb", "USB Audio", 0, true);
        let off = browser("usb", "USB Audio", 1, false);
        let list = party_local_mics(
            &[off, on.clone()],
            &Presence {
                browser: set(&[&on]),
                ..Presence::default()
            },
        );
        assert_eq!(ids(&list), vec![on.local_mic_id.as_str()]);
    }

    #[test]
    fn local_mics_go_in_mics_screen_order() {
        // This browser first, devices by name and channels by number; then
        // bridges in order of approval, whatever their names.
        let zebra = browser("a", "Zebra", 0, true);
        let usb_right = browser("b", "USB Audio", 1, true);
        let usb_left = browser("b", "USB Audio", 0, true);
        let second_bridge = bridged("bb", "card-a", "Alpha", 0, true);
        let first_bridge_2 = bridged("aa", "card-z", "Scarlett", 1, true);
        let first_bridge_1 = bridged("aa", "card-z", "Scarlett", 0, true);
        let list = party_local_mics(
            &[
                second_bridge.clone(),
                zebra.clone(),
                first_bridge_2.clone(),
                usb_right.clone(),
                first_bridge_1.clone(),
                usb_left.clone(),
            ],
            &Presence {
                bridges: vec![BridgeId("aa".into()), BridgeId("bb".into())],
                ..Presence::default()
            },
        );
        assert_eq!(
            ids(&list),
            vec![
                usb_left.local_mic_id.as_str(),
                usb_right.local_mic_id.as_str(),
                zebra.local_mic_id.as_str(),
                first_bridge_1.local_mic_id.as_str(),
                first_bridge_2.local_mic_id.as_str(),
                second_bridge.local_mic_id.as_str(),
            ]
        );
    }

    #[test]
    fn an_unplugged_or_closed_bridge_local_mic_is_listed_but_not_present() {
        let plugged = browser("usb", "USB Audio", 0, true);
        let unplugged = browser("gone", "Old dongle", 0, true);
        let open = bridged("aa", "card", "Scarlett", 0, true);
        let closed = bridged("bb", "card", "UMC404HD", 0, true);
        let list = party_local_mics(
            &[
                plugged.clone(),
                unplugged.clone(),
                open.clone(),
                closed.clone(),
            ],
            &Presence {
                browser: set(&[&plugged]),
                bridge_channels: set(&[&open]),
                bridges: vec![BridgeId("aa".into()), BridgeId("bb".into())],
            },
        );
        let present: HashMap<&str, bool> = list
            .iter()
            .map(|mic| (mic.local_mic_id.as_str(), mic.present))
            .collect();
        assert_eq!(present.len(), 4);
        assert!(present[plugged.local_mic_id.as_str()]);
        assert!(!present[unplugged.local_mic_id.as_str()]);
        assert!(present[open.local_mic_id.as_str()]);
        assert!(!present[closed.local_mic_id.as_str()]);
        assert_eq!(
            present_ids(&list),
            vec![plugged.local_mic_id.clone(), open.local_mic_id.clone()]
        );
    }

    fn party(members: u32) -> PartySnapshot {
        PartySnapshot {
            party_id: PartyId("p".into()),
            stage_id: StageId("main".into()),
            join_code: JoinCode("0427".into()),
            started_at_ms: 0,
            members: (1..=members)
                .map(|n| PartyMember {
                    member_id: PartyMemberId(n),
                    identity: Identity::Profile {
                        profile_id: openstar_protocol::profile::ProfileId(n),
                    },
                    colour: openstar_protocol::profile::PaletteKey::ALL[n as usize],
                    favourite_taken: false,
                    on_phone: false,
                    singing: false,
                })
                .collect(),
            phones: Vec::new(),
            queue: Vec::new(),
            head: None,
            line_up: None,
            playing: None,
            results: None,
            local_mics: Vec::new(),
        }
    }

    /// The Mics `players` are prefilled with when the Local mics are `kept`
    /// and present as `presence` says.
    fn prefilled(
        players: u32,
        kept: &[LocalMic],
        presence: &Presence,
        last: &[(u32, &LocalMic)],
    ) -> Vec<Option<String>> {
        let party = party(players);
        let request = Request {
            request_id: RequestId(1),
            kind: RequestKind::Song,
            song_id: openstar_protocol::library::SongId(1),
            requested_players: (1..=players).map(PartyMemberId).collect(),
            adder: None,
        };
        let mics = MicChoices {
            local_mics: present_ids(&party_local_mics(kept, presence)),
            last_local_mics: last
                .iter()
                .map(|(member, mic)| (PartyMemberId(*member), mic.local_mic_id.clone()))
                .collect(),
        };
        prefill(&party, &request, false, &HashMap::new(), &mics)
            .seats
            .into_iter()
            .map(|seat| {
                seat.mic.map(|mic| match mic {
                    MicKey::LocalMic { local_mic_id } => local_mic_id,
                    MicKey::Phone { phone_id } => phone_id,
                })
            })
            .collect()
    }

    #[test]
    fn an_unplugged_or_closed_bridge_local_mic_is_never_free() {
        let unplugged = browser("gone", "A dongle", 0, true);
        let closed = bridged("aa", "card", "B interface", 0, true);
        let plugged = browser("usb", "C dongle", 0, true);
        let kept = [unplugged.clone(), closed.clone(), plugged.clone()];
        let presence = Presence {
            browser: set(&[&plugged]),
            bridge_channels: HashSet::new(),
            bridges: vec![BridgeId("aa".into())],
        };
        // Even as the Local mic member 1 last sang on.
        assert_eq!(
            prefilled(2, &kept, &presence, &[(1, &unplugged), (2, &closed)]),
            vec![Some(plugged.local_mic_id.clone()), None]
        );
    }

    #[test]
    fn a_switched_off_local_mic_is_never_prefilled() {
        let off = browser("usb", "USB Audio", 0, false);
        let presence = Presence {
            browser: set(&[&off]),
            ..Presence::default()
        };
        assert_eq!(prefilled(1, &[off], &presence, &[]), vec![None]);
    }

    #[test]
    fn a_seated_local_mic_is_never_free() {
        let red = browser("usb", "USB Audio", 0, true);
        let presence = Presence {
            browser: set(&[&red]),
            ..Presence::default()
        };
        assert_eq!(
            prefilled(2, std::slice::from_ref(&red), &presence, &[(2, &red)]),
            vec![Some(red.local_mic_id.clone()), None]
        );
    }
}
