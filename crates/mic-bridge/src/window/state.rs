//! What the window shows, kept from the connection loop's [`Event`]s: the
//! server address, the status, and one row per interface and channel with
//! its name, whether it is on, and its level while its interface is open.
//! Pure, so every state the window can be in is built in tests.

use std::collections::HashMap;

use openstar_protocol::ServerMessage;
use openstar_protocol::bridge::{BridgeChannelSettings, BridgeInterface};

use crate::client::{Event, default_name};

/// The connection status line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// Trying to reach the server; `problem` says why the last try failed.
    Connecting { problem: Option<String> },
    /// The server asks the Stage to approve this bridge, showing `code`.
    Waiting { code: String },
    /// Approved and connected.
    Connected,
    /// The bridge cannot connect at all (no server address, for example).
    Stopped { problem: String },
}

/// One input channel's row.
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelRow {
    /// The name the Stage gave it, or its default name.
    pub name: String,
    pub switched_on: bool,
    /// The level over the last tenth of a second, while the interface is open.
    pub level_dbfs: Option<f64>,
}

/// One interface and its channels, in hardware channel order.
#[derive(Debug, Clone, PartialEq)]
pub struct InterfaceRows {
    pub label: String,
    pub open: bool,
    pub channels: Vec<ChannelRow>,
}

/// Everything the window shows.
#[derive(Debug, Clone)]
pub struct WindowState {
    server: String,
    status: Status,
    interfaces: Vec<BridgeInterface>,
    settings: Vec<BridgeChannelSettings>,
    levels: HashMap<String, Vec<f64>>,
}

impl WindowState {
    /// Before the first connection attempt to `server`.
    pub fn new(server: impl Into<String>, interfaces: Vec<BridgeInterface>) -> Self {
        Self {
            server: server.into(),
            status: Status::Connecting { problem: None },
            interfaces,
            settings: Vec::new(),
            levels: HashMap::new(),
        }
    }

    /// The bridge stopped trying to connect: it shows `problem`.
    pub fn stop(&mut self, problem: impl Into<String>) {
        self.status = Status::Stopped {
            problem: problem.into(),
        };
        self.levels.clear();
    }

    pub fn server(&self) -> &str {
        &self.server
    }

    pub fn status(&self) -> &Status {
        &self.status
    }

    /// Takes in what the connection loop did.
    pub fn apply(&mut self, event: Event<'_>) {
        match event {
            Event::Connecting { server } => {
                server.clone_into(&mut self.server);
                if !matches!(self.status, Status::Connecting { .. }) {
                    self.status = Status::Connecting { problem: None };
                }
            }
            Event::NotConnected { error } => {
                self.status = Status::Connecting {
                    problem: Some(format!("{error:#}")),
                };
                self.levels.clear();
            }
            Event::Disconnected => {
                self.status = Status::Connecting { problem: None };
                self.levels.clear();
            }
            Event::Received(message) => self.received(message),
            Event::InterfaceOpen { device_name, open } => {
                if open {
                    self.levels.entry(device_name.to_owned()).or_default();
                } else {
                    self.levels.remove(device_name);
                }
            }
            Event::Levels {
                device_name,
                levels_dbfs,
            } => {
                if let Some(levels) = self.levels.get_mut(device_name) {
                    levels_dbfs.clone_into(levels);
                }
            }
        }
    }

    fn received(&mut self, message: &ServerMessage) {
        match message {
            ServerMessage::BridgeWaiting { code } => {
                self.status = Status::Waiting { code: code.clone() };
            }
            ServerMessage::BridgeConnected { .. } => self.status = Status::Connected,
            ServerMessage::BridgeChannels { channels } => channels.clone_into(&mut self.settings),
            _ => {}
        }
    }

    /// One entry per interface, each with one row per channel.
    pub fn interfaces(&self) -> Vec<InterfaceRows> {
        self.interfaces
            .iter()
            .map(|interface| {
                let levels = self.levels.get(&interface.device_name);
                let channels = (0..interface.channels)
                    .map(|channel| {
                        let settings = self.settings.iter().find(|s| {
                            s.device_name == interface.device_name && s.channel == channel
                        });
                        let name = settings
                            .map(|s| s.name.trim())
                            .filter(|name| !name.is_empty())
                            .map_or_else(|| default_name(&interface.label, channel), str::to_owned);
                        ChannelRow {
                            name,
                            switched_on: settings.is_some_and(|s| s.switched_on),
                            level_dbfs: levels
                                .map(|levels| levels.get(channel as usize).copied())
                                .map(|level| level.unwrap_or(crate::levels::SILENCE_DBFS)),
                        }
                    })
                    .collect();
                InterfaceRows {
                    label: interface.label.clone(),
                    open: levels.is_some(),
                    channels,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openstar_protocol::bridge::BridgeId;

    const DEVICE: &str = "alsa_card.usb-Focusrite_Scarlett_4i4-00";

    fn scarlett() -> WindowState {
        WindowState::new(
            "http://openstar.lan:8080",
            vec![BridgeInterface {
                device_name: DEVICE.into(),
                label: "Scarlett 4i4".into(),
                channels: 2,
            }],
        )
    }

    fn channel(channel: u32, switched_on: bool, name: &str) -> BridgeChannelSettings {
        BridgeChannelSettings {
            device_name: DEVICE.into(),
            channel,
            local_mic_id: format!("bridge:b:{DEVICE}:{channel}"),
            switched_on,
            name: name.into(),
        }
    }

    fn rows(state: &WindowState) -> Vec<(String, bool, Option<f64>)> {
        state.interfaces()[0]
            .channels
            .iter()
            .map(|row| (row.name.clone(), row.switched_on, row.level_dbfs))
            .collect()
    }

    #[test]
    fn at_first_it_is_connecting_with_default_names_off_and_no_meter() {
        let state = scarlett();
        assert_eq!(state.server(), "http://openstar.lan:8080");
        assert_eq!(state.status(), &Status::Connecting { problem: None });
        assert_eq!(
            rows(&state),
            vec![
                ("Scarlett 4i4 · Input 1".into(), false, None),
                ("Scarlett 4i4 · Input 2".into(), false, None),
            ]
        );
        assert!(!state.interfaces()[0].open);
    }

    #[test]
    fn waiting_shows_the_code_then_connected() {
        let mut state = scarlett();
        state.apply(Event::Received(&ServerMessage::BridgeWaiting {
            code: "4821".into(),
        }));
        assert_eq!(
            state.status(),
            &Status::Waiting {
                code: "4821".into()
            }
        );
        state.apply(Event::Received(&ServerMessage::BridgeConnected {
            bridge_id: BridgeId("b".into()),
        }));
        assert_eq!(state.status(), &Status::Connected);
    }

    #[test]
    fn rows_take_the_stage_name_and_whether_it_is_on() {
        let mut state = scarlett();
        state.apply(Event::Received(&ServerMessage::BridgeChannels {
            channels: vec![channel(0, true, "Red mic"), channel(1, false, " ")],
        }));
        assert_eq!(
            rows(&state),
            vec![
                ("Red mic".into(), true, None),
                ("Scarlett 4i4 · Input 2".into(), false, None),
            ]
        );
    }

    #[test]
    fn an_open_interface_meters_every_channel_until_it_closes() {
        let mut state = scarlett();
        state.apply(Event::InterfaceOpen {
            device_name: DEVICE,
            open: true,
        });
        assert!(state.interfaces()[0].open);
        assert_eq!(rows(&state)[0].2, Some(-100.0), "silent until levels come");
        state.apply(Event::Levels {
            device_name: DEVICE,
            levels_dbfs: &[-12.5, -60.0],
        });
        assert_eq!(rows(&state)[0].2, Some(-12.5));
        assert_eq!(rows(&state)[1].2, Some(-60.0));
        state.apply(Event::InterfaceOpen {
            device_name: DEVICE,
            open: false,
        });
        assert_eq!(rows(&state)[0].2, None);
        state.apply(Event::Levels {
            device_name: DEVICE,
            levels_dbfs: &[-3.0, -3.0],
        });
        assert_eq!(rows(&state)[0].2, None, "a closed interface shows no meter");
    }

    #[test]
    fn losing_the_connection_goes_back_to_connecting_without_meters() {
        let mut state = scarlett();
        state.apply(Event::Received(&ServerMessage::BridgeConnected {
            bridge_id: BridgeId("b".into()),
        }));
        state.apply(Event::InterfaceOpen {
            device_name: DEVICE,
            open: true,
        });
        let error = anyhow::anyhow!("connection refused");
        state.apply(Event::NotConnected { error: &error });
        assert_eq!(
            state.status(),
            &Status::Connecting {
                problem: Some("connection refused".into())
            }
        );
        assert_eq!(rows(&state)[0].2, None);
        // The next attempt keeps showing why the last one failed.
        state.apply(Event::Connecting {
            server: "http://openstar.lan:8080",
        });
        assert_eq!(
            state.status(),
            &Status::Connecting {
                problem: Some("connection refused".into())
            }
        );
        state.apply(Event::Disconnected);
        assert_eq!(state.status(), &Status::Connecting { problem: None });
    }
}
