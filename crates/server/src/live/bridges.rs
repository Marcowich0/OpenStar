//! Mic bridges in the live state: which approved bridges are open, which
//! bridges wait for approval, and what each connected bridge is told about
//! its channels. Approved bridges themselves are kept by
//! [`crate::mic_bridges`]; this is the part that lives only while the
//! server runs (a waiting bridge asks again after a restart).

use std::collections::{HashMap, HashSet};

use openstar_protocol::bridge::{
    BridgeChannel, BridgeChannelSettings, BridgeId, BridgeInputDelay, BridgeInterface, BridgeLevel,
    BridgeRequest, BridgeRequestId, LocalMicLevel, MicBridge, MicBridges, NotProAudio,
    bridge_local_mic_id, loopback_number,
};
use openstar_protocol::mics::{LocalMicSource, MicKey};
use openstar_protocol::{
    BridgeInput, ChangeTopic, MicId, PartySnapshot, ServerMessage, UserMessage,
};

use super::LiveState;
use super::hub::ConnectionId;
use crate::mic_bridges::{self, Approved};

/// The lowest level a meter shows, in dBFS: silence.
const SILENCE_DBFS: f64 = -100.0;

/// The Mic bridge part of the live state.
#[derive(Default)]
pub(super) struct Bridges {
    /// Every approved bridge, in order of approval (loaded at start).
    pub approved: Vec<Approved>,
    /// Connections opened on `/ws/bridge`; only these may say hello.
    pub sockets: std::collections::HashSet<ConnectionId>,
    /// Bridges waiting for approval, oldest first.
    pub waiting: Vec<Waiting>,
    /// Approved bridges that are connected, by connection.
    pub open: HashMap<ConnectionId, Open>,
    next_request: u32,
    /// The Stage connection whose Mics screen is open: it counts only while
    /// that connection is still the active Stage.
    mics_screen: Option<ConnectionId>,
    /// What open bridges were last told about the Mics screen.
    told_mics_screen: bool,
}

pub(super) struct Waiting {
    pub connection: ConnectionId,
    pub request_id: BridgeRequestId,
    pub host_name: String,
    pub code: String,
    pub interfaces: Vec<BridgeInterface>,
    pub not_pro_audio: Vec<NotProAudio>,
}

pub(super) struct Open {
    pub bridge_id: BridgeId,
    pub interfaces: Vec<BridgeInterface>,
    /// The interfaces it sees that are not in Pro Audio, as it last said.
    pub not_pro_audio: Vec<NotProAudio>,
    /// The channels it was last told detect ([`ServerMessage::BridgeDetecting`]).
    pub told_detecting: Vec<BridgeInput>,
    /// The input delays it reported, by channel.
    pub input_delays: HashMap<BridgeInput, f64>,
}

impl Bridges {
    /// No bridge connected yet; `approved` as kept.
    pub fn new(approved: Vec<Approved>) -> Self {
        Self {
            approved,
            ..Self::default()
        }
    }

    /// What `GET /api/mic-bridges` answers.
    pub fn listing(&self) -> MicBridges {
        let bridges = self
            .approved
            .iter()
            .map(|approved| {
                let open = self
                    .open
                    .values()
                    .find(|open| open.bridge_id == approved.bridge_id);
                MicBridge {
                    bridge_id: approved.bridge_id.clone(),
                    host_name: approved.host_name.clone(),
                    open: open.is_some(),
                    channels: open.map(channels_of).unwrap_or_default(),
                    interfaces: open.map(|open| open.interfaces.clone()).unwrap_or_default(),
                    not_pro_audio: open
                        .map(|open| open.not_pro_audio.clone())
                        .unwrap_or_default(),
                }
            })
            .collect();
        let requests = self
            .waiting
            .iter()
            .map(|waiting| BridgeRequest {
                request_id: waiting.request_id,
                host_name: waiting.host_name.clone(),
                code: waiting.code.clone(),
            })
            .collect();
        MicBridges { bridges, requests }
    }

    /// The Local mic ids of every channel an open bridge offers now.
    pub fn offered_local_mics(&self) -> std::collections::HashSet<String> {
        self.open
            .values()
            .flat_map(channels_of)
            .map(|channel| channel.local_mic_id)
            .collect()
    }

    /// The approved bridges' ids, in order of approval.
    pub fn approved_ids(&self) -> Vec<BridgeId> {
        self.approved.iter().map(|a| a.bridge_id.clone()).collect()
    }
}

impl Open {
    /// The Mic of the hardware channel `input`, if this bridge offers it.
    fn mic(&self, input: &BridgeInput) -> Option<MicId> {
        self.offers(input).then(|| MicId::Bridge {
            bridge_id: self.bridge_id.clone(),
            local_mic_id: bridge_local_mic_id(&self.bridge_id, &input.device_name, input.channel),
        })
    }

    /// The hardware channel whose Local mic id is `local_mic_id`.
    fn input_of(&self, local_mic_id: &str) -> Option<BridgeInput> {
        self.inputs().find(|input| {
            bridge_local_mic_id(&self.bridge_id, &input.device_name, input.channel) == local_mic_id
        })
    }

    /// Whether it offers hardware channel `input`.
    fn offers(&self, input: &BridgeInput) -> bool {
        self.interfaces.iter().any(|interface| {
            interface.device_name == input.device_name && input.channel < interface.channels
        })
    }

    /// Every hardware channel it offers, interface by interface.
    fn inputs(&self) -> impl Iterator<Item = BridgeInput> + '_ {
        self.interfaces.iter().flat_map(|interface| {
            (0..interface.channels).map(|channel| BridgeInput {
                device_name: interface.device_name.clone(),
                channel,
            })
        })
    }
}

/// Every hardware channel of an open bridge, interface by interface.
fn channels_of(open: &Open) -> Vec<BridgeChannel> {
    open.interfaces
        .iter()
        .flat_map(|interface| {
            (0..interface.channels).map(|channel| BridgeChannel {
                local_mic_id: bridge_local_mic_id(&open.bridge_id, &interface.device_name, channel),
                source: LocalMicSource::Bridge {
                    bridge_id: open.bridge_id.clone(),
                    device_name: interface.device_name.clone(),
                    label: interface.label.clone(),
                    channel,
                    loopback: loopback_number(interface.usb_id.as_deref(), channel),
                },
                reported_input_delay_ms: open
                    .input_delays
                    .get(&BridgeInput {
                        device_name: interface.device_name.clone(),
                        channel,
                    })
                    .copied(),
            })
        })
        .collect()
}

/// The Local mic ids whose detectors run: every switched-on Local mic
/// seated in the Line-up while a Song plays (paused included, or the
/// lost-Mic rule would take a pause for a lost Mic). The same rule as the
/// Stage browser's (`detectingLocalMics` in `web/src/mics/localMicPitch.ts`).
/// #210 adds the Local mics of a Calibration run.
fn detecting_local_mics(party: Option<&PartySnapshot>) -> HashSet<String> {
    let Some(party) = party.filter(|party| party.playing.is_some()) else {
        return HashSet::new();
    };
    let Some(line_up) = &party.line_up else {
        return HashSet::new();
    };
    let switched_on: HashSet<&str> = party
        .local_mics
        .iter()
        .map(|mic| mic.local_mic_id.as_str())
        .collect();
    line_up
        .seats
        .iter()
        .filter_map(|seat| match &seat.mic {
            Some(MicKey::LocalMic { local_mic_id })
                if switched_on.contains(local_mic_id.as_str()) =>
            {
                Some(local_mic_id.clone())
            }
            _ => None,
        })
        .collect()
}

impl LiveState {
    /// A bridge said hello: straight in with a valid token, otherwise it
    /// waits for approval with a new code. A bridge of another build is
    /// only told the server's build, so it updates itself first.
    pub(super) async fn bridge_hello(
        &mut self,
        id: ConnectionId,
        build: String,
        host_name: String,
        token: Option<String>,
        interfaces: Vec<BridgeInterface>,
    ) {
        if !self.bridges.sockets.contains(&id) {
            self.reject(id, UserMessage::NotABridge);
            return;
        }
        if build != crate::BUILD_ID {
            // Only the exact build connects: the bridge updates itself and
            // says hello again (no protocol version, no compatible range).
            tracing::info!(%build, server = crate::BUILD_ID, "a Mic bridge of another build said hello: it updates");
            self.hub.send_to(
                id,
                &ServerMessage::BridgeUpdate {
                    build: crate::BUILD_ID.to_owned(),
                },
            );
            return;
        }
        let host_name = mic_bridges::clean_host_name(&host_name);
        // A second hello replaces the first.
        self.bridges.waiting.retain(|w| w.connection != id);
        self.bridges.open.remove(&id);

        let approved = token
            .map(|token| mic_bridges::bridge_id_of(&token))
            .and_then(|bridge_id| {
                self.bridges
                    .approved
                    .iter()
                    .position(|a| a.bridge_id == bridge_id)
            });
        match approved {
            Some(index) => {
                if self.bridges.approved[index].host_name != host_name {
                    self.bridges.approved[index].host_name = host_name;
                    let kept =
                        mic_bridges::set_host_name(&self.db, self.bridges.approved[index].clone())
                            .await;
                    if let Err(error) = kept {
                        tracing::error!(?error, "keeping a Mic bridge's host name");
                    }
                }
                let bridge_id = self.bridges.approved[index].bridge_id.clone();
                self.bridge_opened(id, bridge_id, interfaces, Vec::new())
                    .await;
            }
            None => {
                let taken: Vec<&str> = self
                    .bridges
                    .waiting
                    .iter()
                    .map(|w| w.code.as_str())
                    .collect();
                let code = match mic_bridges::draw_code(&taken) {
                    Ok(code) => code,
                    Err(error) => {
                        tracing::error!(?error, "drawing a Mic bridge code");
                        self.reject(id, UserMessage::ServerError);
                        return;
                    }
                };
                let request_id = BridgeRequestId(self.bridges.next_request);
                self.bridges.next_request = self.bridges.next_request.wrapping_add(1);
                self.bridges.waiting.push(Waiting {
                    connection: id,
                    request_id,
                    host_name,
                    code: code.clone(),
                    interfaces,
                    not_pro_audio: Vec::new(),
                });
                self.hub.send_to(id, &ServerMessage::BridgeWaiting { code });
                self.bridges_changed();
            }
        }
    }

    /// The Stage approves a waiting bridge: it is kept, handed its token
    /// and connected.
    pub(super) async fn approve_bridge(
        &mut self,
        id: ConnectionId,
        request_id: BridgeRequestId,
        now_ms: i64,
    ) {
        if self.stage().connection != Some(id) {
            self.reject(id, UserMessage::NotTheStage);
            return;
        }
        let Some(index) = self
            .bridges
            .waiting
            .iter()
            .position(|w| w.request_id == request_id)
        else {
            self.reject(id, UserMessage::BridgeRequestNotFound);
            return;
        };
        let token = match mic_bridges::new_token() {
            Ok(token) => token,
            Err(error) => {
                tracing::error!(?error, "making a Mic bridge token");
                self.reject(id, UserMessage::ServerError);
                return;
            }
        };
        let approved = Approved {
            bridge_id: mic_bridges::bridge_id_of(&token),
            host_name: self.bridges.waiting[index].host_name.clone(),
        };
        if let Err(error) = mic_bridges::approve(&self.db, approved.clone(), now_ms).await {
            tracing::error!(?error, "keeping an approved Mic bridge");
            self.reject(id, UserMessage::ServerError);
            return;
        }
        let waiting = self.bridges.waiting.remove(index);
        self.bridges.approved.push(approved.clone());
        tracing::info!(host = %approved.host_name, "a Mic bridge was approved");
        self.hub
            .send_to(waiting.connection, &ServerMessage::BridgeApproved { token });
        self.bridge_opened(
            waiting.connection,
            approved.bridge_id,
            waiting.interfaces,
            waiting.not_pro_audio,
        )
        .await;
    }

    /// An approved bridge is connected on `id`: it is told so and its
    /// channels, and the Stage that the bridges changed. An older connection
    /// of the same bridge is closed.
    async fn bridge_opened(
        &mut self,
        id: ConnectionId,
        bridge_id: BridgeId,
        interfaces: Vec<BridgeInterface>,
        not_pro_audio: Vec<NotProAudio>,
    ) {
        let older: Vec<ConnectionId> = self
            .bridges
            .open
            .iter()
            .filter(|(_, open)| open.bridge_id == bridge_id)
            .map(|(&older, _)| older)
            .collect();
        for older in older {
            self.bridges.open.remove(&older);
            self.hub.remove(older);
        }
        self.hub.send_to(
            id,
            &ServerMessage::BridgeConnected {
                bridge_id: bridge_id.clone(),
            },
        );
        self.bridges.open.insert(
            id,
            Open {
                bridge_id,
                interfaces,
                not_pro_audio,
                told_detecting: Vec::new(),
                input_delays: HashMap::new(),
            },
        );
        self.send_bridge_channels(Some(id)).await;
        let open = self.mics_screen_open();
        self.hub
            .send_to(id, &ServerMessage::BridgeMicsScreen { open });
        self.tell_bridges_detecting();
        self.bridges_changed();
        // Its switched-on Local mics are present again.
        self.local_mics_changed();
    }

    /// A bridge says what it sees now: what it offers and its interfaces
    /// not in Pro Audio, replacing what it said before. For an open bridge
    /// the channels it no longer offers close (a profile switched away is
    /// a lost Mic, like an unplugged interface), it is told its channels
    /// with their kept names, and the Stage that bridges and Local mics
    /// changed. Dropped from a socket that is not a bridge's.
    pub(super) async fn bridge_interfaces(
        &mut self,
        id: ConnectionId,
        interfaces: Vec<BridgeInterface>,
        not_pro_audio: Vec<NotProAudio>,
    ) {
        if let Some(waiting) = self.bridges.waiting.iter_mut().find(|w| w.connection == id) {
            waiting.interfaces = interfaces;
            waiting.not_pro_audio = not_pro_audio;
            return;
        }
        let Some(open) = self.bridges.open.get_mut(&id) else {
            return;
        };
        let before: Vec<BridgeInput> = open.inputs().collect();
        open.interfaces = interfaces;
        open.not_pro_audio = not_pro_audio;
        let gone: Vec<MicId> = before
            .iter()
            .filter(|input| !open.offers(input))
            .map(|input| MicId::Bridge {
                bridge_id: open.bridge_id.clone(),
                local_mic_id: bridge_local_mic_id(
                    &open.bridge_id,
                    &input.device_name,
                    input.channel,
                ),
            })
            .collect();
        let offered: Vec<BridgeInput> = open.inputs().collect();
        open.input_delays.retain(|input, _| offered.contains(input));
        let changed_inputs = before != offered;
        for mic in gone {
            self.send_to_stage(&ServerMessage::MicClosed { mic });
        }
        if changed_inputs {
            self.send_bridge_channels(Some(id)).await;
            self.tell_bridges_detecting();
        }
        self.bridges_changed();
        if changed_inputs {
            self.local_mics_changed();
        }
    }

    /// Switch to Pro Audio on the Stage: passed to the open bridge, which
    /// tries the switch itself.
    pub(super) fn switch_bridge_to_pro_audio(
        &mut self,
        id: ConnectionId,
        bridge_id: &BridgeId,
        device_name: String,
    ) {
        if self.stage().connection != Some(id) {
            self.reject(id, UserMessage::NotTheStage);
            return;
        }
        let Some(&bridge) = self
            .bridges
            .open
            .iter()
            .find(|(_, open)| &open.bridge_id == bridge_id)
            .map(|(connection, _)| connection)
        else {
            self.reject(id, UserMessage::BridgeNotFound);
            return;
        };
        self.hub
            .send_to(bridge, &ServerMessage::BridgeSwitchProfile { device_name });
    }

    /// The active Stage says its Mics screen opened or closed.
    pub(super) fn set_mics_screen_open(&mut self, id: ConnectionId, open: bool) {
        if self.stage().connection != Some(id) {
            self.reject(id, UserMessage::NotTheStage);
            return;
        }
        self.bridges.mics_screen = open.then_some(id);
        self.tell_mics_screen();
    }

    /// Whether the active Stage's Mics screen is open.
    fn mics_screen_open(&self) -> bool {
        let stage = self.stages.get(&self.current_stage);
        self.bridges.mics_screen.is_some()
            && self.bridges.mics_screen == stage.and_then(|stage| stage.connection)
    }

    /// Tells every open bridge whether the Mics screen is open, if that
    /// changed since they were last told. Called whenever the Stage
    /// connection or its Mics screen may have changed.
    pub(super) fn tell_mics_screen(&mut self) {
        let open = self.mics_screen_open();
        if open == self.bridges.told_mics_screen {
            return;
        }
        self.bridges.told_mics_screen = open;
        let bridges: Vec<ConnectionId> = self.bridges.open.keys().copied().collect();
        for id in bridges {
            self.hub
                .send_to(id, &ServerMessage::BridgeMicsScreen { open });
        }
    }

    /// Levels from a bridge: relayed to the Stage under their Local mic ids
    /// if the bridge is open, only for channels it offers. Dropped otherwise.
    pub(super) fn bridge_levels(&mut self, id: ConnectionId, levels: Vec<BridgeLevel>) {
        let Some(open) = self.bridges.open.get(&id) else {
            return;
        };
        let levels: Vec<LocalMicLevel> = levels
            .into_iter()
            .filter(|level| {
                open.interfaces.iter().any(|interface| {
                    interface.device_name == level.device_name && level.channel < interface.channels
                })
            })
            .map(|level| LocalMicLevel {
                local_mic_id: bridge_local_mic_id(
                    &open.bridge_id,
                    &level.device_name,
                    level.channel,
                ),
                level_dbfs: level.level_dbfs.clamp(SILENCE_DBFS, 0.0),
            })
            .collect();
        if !levels.is_empty() {
            self.send_to_stage(&ServerMessage::LocalMicLevels { levels });
        }
    }

    /// Tells every open bridge whose detecting channels changed since it was
    /// last told which of its channels detect now. Called after every Party
    /// change and when a bridge connects.
    pub(super) fn tell_bridges_detecting(&mut self) {
        let detecting = detecting_local_mics(self.stage().party.as_ref());
        let mut tell = Vec::new();
        for (&id, open) in &mut self.bridges.open {
            let channels: Vec<BridgeInput> = open
                .inputs()
                .filter(|input| {
                    detecting.contains(&bridge_local_mic_id(
                        &open.bridge_id,
                        &input.device_name,
                        input.channel,
                    ))
                })
                .collect();
            if channels != open.told_detecting {
                open.told_detecting = channels.clone();
                tell.push((id, channels));
            }
        }
        for (id, channels) in tell {
            self.hub
                .send_to(id, &ServerMessage::BridgeDetecting { channels });
        }
    }

    /// Input delays an open bridge reported: kept for the channels it
    /// offers until it closes, and listed. Dropped from any other socket.
    pub(super) fn bridge_input_delays(&mut self, id: ConnectionId, delays: Vec<BridgeInputDelay>) {
        let Some(open) = self.bridges.open.get_mut(&id) else {
            return;
        };
        let mut changed = false;
        for delay in delays {
            let input = BridgeInput {
                device_name: delay.device_name,
                channel: delay.channel,
            };
            if !open.offers(&input) || !delay.delay_ms.is_finite() {
                continue;
            }
            let delay_ms = delay.delay_ms.max(0.0);
            if open.input_delays.insert(input, delay_ms) != Some(delay_ms) {
                changed = true;
            }
        }
        if changed {
            self.bridges_changed();
        }
    }

    /// The Mic that bridge socket `id` sends a reading or ping as: one of
    /// its Local mics, if the bridge is approved and open and offers
    /// `input`. `None` drops it: an unapproved bridge's readings never
    /// reach the Stage, and a bridge must say which Local mic it means.
    pub(super) fn bridge_mic(
        &self,
        id: ConnectionId,
        input: Option<&BridgeInput>,
    ) -> Option<MicId> {
        self.bridges.open.get(&id)?.mic(input?)
    }

    /// The Stage's pong for one Local mic of a bridge: to that bridge's open
    /// connection, naming the Local mic. Dropped when the bridge has gone.
    pub(super) fn bridge_pong(
        &mut self,
        bridge_id: &BridgeId,
        local_mic_id: &str,
        t0: f64,
        ts: f64,
        epoch: f64,
    ) {
        let target = self.bridges.open.iter().find_map(|(&id, open)| {
            (&open.bridge_id == bridge_id)
                .then(|| open.input_of(local_mic_id).map(|input| (id, input)))
                .flatten()
        });
        if let Some((id, input)) = target {
            self.hub.send_to(
                id,
                &ServerMessage::ClockPong {
                    t0,
                    ts,
                    epoch,
                    input: Some(input),
                },
            );
        }
    }

    /// Tells open bridges (`only` one, or every one) each of their channels:
    /// switched on or not, and its name.
    pub(super) async fn send_bridge_channels(&mut self, only: Option<ConnectionId>) {
        if self.bridges.open.is_empty() {
            return;
        }
        let kept = match crate::local_mics::all(&self.db).await {
            Ok(kept) => kept,
            Err(error) => {
                tracing::error!(?error, "reading Local mics for a Mic bridge");
                return;
            }
        };
        let kept: HashMap<String, (bool, String)> = kept
            .into_iter()
            .map(|mic| (mic.local_mic_id, (mic.switched_on, mic.name)))
            .collect();
        let targets: Vec<(ConnectionId, Vec<BridgeChannelSettings>)> = self
            .bridges
            .open
            .iter()
            .filter(|(id, _)| only.is_none_or(|only| only == **id))
            .map(|(&id, open)| {
                let channels = open
                    .interfaces
                    .iter()
                    .flat_map(|interface| {
                        (0..interface.channels).map(|channel| {
                            let local_mic_id = bridge_local_mic_id(
                                &open.bridge_id,
                                &interface.device_name,
                                channel,
                            );
                            let (switched_on, name) =
                                kept.get(&local_mic_id).cloned().unwrap_or_default();
                            BridgeChannelSettings {
                                device_name: interface.device_name.clone(),
                                channel,
                                local_mic_id,
                                switched_on,
                                name,
                            }
                        })
                    })
                    .collect();
                (id, channels)
            })
            .collect();
        for (id, channels) in targets {
            self.hub
                .send_to(id, &ServerMessage::BridgeChannels { channels });
        }
    }

    /// A connection closed: a waiting bridge stops waiting, an open one
    /// shows as closed and the Stage is told each of its Local mics closed
    /// (an older connection the bridge replaced is no longer open, so it
    /// closes without a notice).
    pub(super) fn bridge_closed(&mut self, id: ConnectionId) {
        self.bridges.sockets.remove(&id);
        let before = self.bridges.waiting.len();
        self.bridges.waiting.retain(|w| w.connection != id);
        let was_waiting = self.bridges.waiting.len() != before;
        let closed = self.bridges.open.remove(&id);
        let was_open = closed.is_some();
        if let Some(open) = closed {
            let mics: Vec<MicId> = open.inputs().filter_map(|input| open.mic(&input)).collect();
            for mic in mics {
                self.send_to_stage(&ServerMessage::MicClosed { mic });
            }
        }
        if was_waiting || was_open {
            self.bridges_changed();
        }
        if was_open {
            self.local_mics_changed();
        }
    }

    fn bridges_changed(&mut self) {
        self.hub.send_all(&ServerMessage::Changed {
            topics: vec![ChangeTopic::MicBridges],
        });
    }
}
