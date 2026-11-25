//! Mic bridges in the live state: which approved bridges are open, which
//! bridges wait for approval, and what each connected bridge is told about
//! its channels. Approved bridges themselves are kept by
//! [`crate::mic_bridges`]; this is the part that lives only while the
//! server runs (a waiting bridge asks again after a restart).

use std::collections::HashMap;

use openstar_protocol::bridge::{
    BridgeChannel, BridgeChannelSettings, BridgeId, BridgeInterface, BridgeRequest,
    BridgeRequestId, MicBridge, MicBridges, bridge_local_mic_id,
};
use openstar_protocol::mics::LocalMicSource;
use openstar_protocol::{ChangeTopic, ServerMessage, UserMessage};

use super::LiveState;
use super::hub::ConnectionId;
use crate::mic_bridges::{self, Approved};

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
}

pub(super) struct Waiting {
    pub connection: ConnectionId,
    pub request_id: BridgeRequestId,
    pub host_name: String,
    pub code: String,
    pub interfaces: Vec<BridgeInterface>,
}

pub(super) struct Open {
    pub bridge_id: BridgeId,
    pub interfaces: Vec<BridgeInterface>,
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
                },
            })
        })
        .collect()
}

impl LiveState {
    /// A bridge said hello: straight in with a valid token, otherwise it
    /// waits for approval with a new code.
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
        let host_name = mic_bridges::clean_host_name(&host_name);
        if build != crate::BUILD_ID {
            // #209 makes the bridge update itself to the server's build.
            tracing::info!(%build, server = crate::BUILD_ID, "a Mic bridge of another build said hello");
        }
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
                self.bridge_opened(id, bridge_id, interfaces).await;
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
        self.bridge_opened(waiting.connection, approved.bridge_id, waiting.interfaces)
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
            },
        );
        self.send_bridge_channels(Some(id)).await;
        self.bridges_changed();
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
    /// shows as closed.
    pub(super) fn bridge_closed(&mut self, id: ConnectionId) {
        self.bridges.sockets.remove(&id);
        let before = self.bridges.waiting.len();
        self.bridges.waiting.retain(|w| w.connection != id);
        let was_waiting = self.bridges.waiting.len() != before;
        let was_open = self.bridges.open.remove(&id).is_some();
        if was_waiting || was_open {
            self.bridges_changed();
        }
    }

    fn bridges_changed(&mut self) {
        self.hub.send_all(&ServerMessage::Changed {
            topics: vec![ChangeTopic::MicBridges],
        });
    }
}
