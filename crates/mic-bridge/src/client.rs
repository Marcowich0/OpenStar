//! Joining the server: say hello with the token (if any) and the
//! interfaces, wait for approval with a code, keep the token handed out,
//! then show each channel as the Stage set it.
//!
//! [`Joining`] is the pure part: it turns each [`ServerMessage`] into what
//! the bridge shows and keeps. [`run`] drives it over a WebSocket and
//! connects again whenever the connection ends.

use std::time::Duration;

use anyhow::Context as _;
use futures_util::{SinkExt as _, StreamExt as _};
use openstar_protocol::bridge::{BridgeChannelSettings, BridgeInterface};
use openstar_protocol::{ClientMessage, ServerMessage};
use tokio_tungstenite::tungstenite::Message;

use crate::config::{ConfigDir, bridge_socket_url};

/// Waits between connection attempts: from the first to the last, then the
/// last again.
const RETRY: [Duration; 4] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
];

/// The name a channel shows when the Stage left it empty (the Stage builds
/// the same one with `t()`): "<device> · Input n", n from 1.
pub fn default_name(label: &str, channel: u32) -> String {
    format!("{label} · Input {}", channel + 1)
}

/// What the bridge does about one message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Show a status line.
    Show(String),
    /// Keep this approval token.
    KeepToken(String),
}

/// The joining state of one connection.
pub struct Joining {
    interfaces: Vec<BridgeInterface>,
}

impl Joining {
    pub fn new(interfaces: Vec<BridgeInterface>) -> Self {
        Self { interfaces }
    }

    /// The first message on the socket.
    pub fn hello(&self, host_name: &str, token: Option<String>) -> ClientMessage {
        ClientMessage::BridgeHello {
            build: crate::BUILD_ID.to_owned(),
            host_name: host_name.to_owned(),
            token,
            interfaces: self.interfaces.clone(),
        }
    }

    /// What to do about `message`. Messages for browsers are ignored.
    pub fn received(&self, message: ServerMessage) -> Vec<Effect> {
        match message {
            ServerMessage::BridgeWaiting { code } => vec![Effect::Show(format!(
                "Waiting for approval on the Stage: code {code}"
            ))],
            ServerMessage::BridgeApproved { token } => vec![Effect::KeepToken(token)],
            ServerMessage::BridgeConnected { .. } => vec![Effect::Show("Connected".into())],
            ServerMessage::BridgeChannels { channels } => channels
                .iter()
                .map(|channel| Effect::Show(self.channel_line(channel)))
                .collect(),
            ServerMessage::Rejected { reason } => {
                vec![Effect::Show(format!("The server refused: {reason:?}"))]
            }
            _ => vec![],
        }
    }

    fn channel_line(&self, channel: &BridgeChannelSettings) -> String {
        let name = if channel.name.is_empty() {
            let label = self
                .interfaces
                .iter()
                .find(|i| i.device_name == channel.device_name)
                .map_or(channel.device_name.as_str(), |i| i.label.as_str());
            default_name(label, channel.channel)
        } else {
            channel.name.clone()
        };
        let state = if channel.switched_on { "on" } else { "off" };
        format!("Channel {name}: {state}")
    }
}

/// The name of this computer.
pub fn host_name() -> String {
    ["/proc/sys/kernel/hostname", "/etc/hostname"]
        .iter()
        .find_map(|file| {
            let name = std::fs::read_to_string(file).ok()?;
            let name = name.trim();
            (!name.is_empty()).then(|| name.to_owned())
        })
        .unwrap_or_else(|| "mic bridge".to_owned())
}

/// Connects to the server in `config` and stays connected, connecting again
/// whenever the connection ends. Returns only on an error no retry fixes.
pub async fn run(config: ConfigDir, interfaces: Vec<BridgeInterface>) -> anyhow::Result<()> {
    let server = config.server()?;
    let url = bridge_socket_url(&server)?;
    let joining = Joining::new(interfaces);
    let host_name = host_name();
    let mut attempt = 0;
    loop {
        println!("Connecting to {server}");
        match session(&config, &url, &joining, &host_name).await {
            Ok(()) => {
                println!("Disconnected");
                attempt = 0;
            }
            Err(error) => println!("Not connected: {error:#}"),
        }
        tokio::time::sleep(RETRY[attempt.min(RETRY.len() - 1)]).await;
        attempt += 1;
    }
}

/// One connection, until it ends.
async fn session(
    config: &ConfigDir,
    url: &str,
    joining: &Joining,
    host_name: &str,
) -> anyhow::Result<()> {
    let (mut socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .with_context(|| format!("connecting to {url}"))?;
    let hello = serde_json::to_string(&joining.hello(host_name, config.token()))?;
    socket.send(Message::text(hello)).await?;
    while let Some(message) = socket.next().await {
        let Message::Text(text) = message? else {
            continue;
        };
        // Same build as the server, so every message parses; anything else
        // is not for the bridge.
        let Ok(message) = serde_json::from_str::<ServerMessage>(&text) else {
            continue;
        };
        for effect in joining.received(message) {
            match effect {
                Effect::Show(line) => println!("{line}"),
                Effect::KeepToken(token) => {
                    config.save_token(&token)?;
                    println!("Approved: the token is kept in {}", config.path().display());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use openstar_protocol::bridge::BridgeId;

    fn wav() -> Joining {
        Joining::new(vec![BridgeInterface {
            device_name: "alsa_card.usb-X-00".into(),
            label: "Scarlett 4i4".into(),
            channels: 4,
        }])
    }

    fn settings(channel: u32, on: bool, name: &str) -> BridgeChannelSettings {
        BridgeChannelSettings {
            device_name: "alsa_card.usb-X-00".into(),
            channel,
            local_mic_id: format!("bridge:b:alsa_card.usb-X-00:{channel}"),
            switched_on: on,
            name: name.into(),
        }
    }

    #[test]
    fn hello_carries_the_build_the_token_and_the_interfaces() {
        let ClientMessage::BridgeHello {
            build,
            host_name,
            token,
            interfaces,
        } = wav().hello("hermes", Some("t".into()))
        else {
            panic!("a hello");
        };
        assert_eq!(build, crate::BUILD_ID);
        assert_eq!(host_name, "hermes");
        assert_eq!(token.as_deref(), Some("t"));
        assert_eq!(interfaces[0].channels, 4);
    }

    #[test]
    fn waiting_shows_the_code_and_an_approval_keeps_the_token() {
        let joining = wav();
        assert_eq!(
            joining.received(ServerMessage::BridgeWaiting {
                code: "4821".into()
            }),
            vec![Effect::Show(
                "Waiting for approval on the Stage: code 4821".into()
            )]
        );
        assert_eq!(
            joining.received(ServerMessage::BridgeApproved { token: "t".into() }),
            vec![Effect::KeepToken("t".into())]
        );
        assert_eq!(
            joining.received(ServerMessage::BridgeConnected {
                bridge_id: BridgeId("b".into())
            }),
            vec![Effect::Show("Connected".into())]
        );
    }

    #[test]
    fn channels_show_their_name_or_the_default_and_whether_they_are_on() {
        let shown = wav().received(ServerMessage::BridgeChannels {
            channels: vec![settings(0, true, "Red mic"), settings(2, false, "")],
        });
        assert_eq!(
            shown,
            vec![
                Effect::Show("Channel Red mic: on".into()),
                Effect::Show("Channel Scarlett 4i4 · Input 3: off".into()),
            ]
        );
    }

    #[test]
    fn messages_for_browsers_are_ignored() {
        assert_eq!(wav().received(ServerMessage::StageMoved), vec![]);
    }
}
