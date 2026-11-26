//! Joining the server: say hello with the token (if any) and the
//! interfaces, wait for approval with a code, keep the token handed out,
//! then show each channel as the Stage set it, open the interfaces the
//! Stage needs, send their meter levels ten times a second, and send Pitch
//! readings for the channels the server says are seated in the Song that
//! plays.
//!
//! [`Joining`], [`crate::levels::Metering`] and
//! [`crate::detecting::Detecting`] are the pure parts: what the bridge shows
//! and keeps for each [`ServerMessage`], which interfaces are open and which
//! channels metered, and which detect. [`run`] drives them over a
//! WebSocket and connects again whenever the connection ends; it tells a
//! [`Report`] what happens (headless prints lines, the window keeps
//! [`Event`]s).
//!
//! A server of another build answers the hello with its build alone; the
//! bridge then updates itself ([`crate::update`]) and [`run`] ends with
//! [`Ended::Updated`] for its caller to restart into the new build.

use std::time::Duration;

use crate::detecting::Detecting;
use crate::levels::{LEVEL_INTERVAL, Metering, channel_digital_silence, channel_levels_dbfs};
use crate::sender::MonotonicClock;
use crate::update::{self, Mismatch, Plan, SelfFile};
use anyhow::Context as _;
use futures_util::{SinkExt as _, StreamExt as _};
use openstar_protocol::bridge::{
    BridgeChannelSettings, BridgeInputDelay, BridgeInterface, NotProAudio, pactl_line,
};
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

/// How often open interfaces are read: often enough that every 10 ms of new
/// samples makes a reading soon after it arrived.
pub const CAPTURE_INTERVAL: Duration = Duration::from_millis(10);

/// The name a channel shows when the Stage left it empty (the Stage builds
/// the same one with `t()`): "<device> · Input n", n from 1, or for a
/// loopback channel of the known-models table "<device> · Loopback n".
pub fn default_name(interface: &BridgeInterface, channel: u32) -> String {
    let label = &interface.label;
    match openstar_protocol::bridge::loopback_number(interface.usb_id.as_deref(), channel) {
        Some(n) => format!("{label} · Loopback {n}"),
        None => format!("{label} · Input {}", channel + 1),
    }
}

/// The profile message of an interface not in Pro Audio: "Scarlett 4i4 is
/// in Analog Surround 2.1: only some inputs reach OpenStar" (the Stage says
/// the same with `t()`).
pub fn profile_message(card: &NotProAudio) -> String {
    let label = &card.label;
    if card.profile.is_empty() {
        format!("{label} is not in Pro Audio: only some inputs reach OpenStar")
    } else {
        format!(
            "{label} is in {}: only some inputs reach OpenStar",
            card.profile
        )
    }
}

/// What a refused switch says instead of the button, with [`pactl_line`].
pub const SWITCH_REFUSED: &str = "Set its profile to Pro Audio in your sound settings, or run:";

/// The status lines headless prints about the profile messages.
fn profile_lines(not_pro_audio: &[NotProAudio]) -> Vec<String> {
    not_pro_audio
        .iter()
        .map(|card| {
            if card.switch_refused {
                format!(
                    "{} {SWITCH_REFUSED} {}",
                    profile_message(card),
                    pactl_line(&card.card_name)
                )
            } else {
                profile_message(card)
            }
        })
        .collect()
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
#[derive(Clone)]
pub struct Joining {
    interfaces: Vec<BridgeInterface>,
    build: String,
}

impl Joining {
    pub fn new(interfaces: Vec<BridgeInterface>) -> Self {
        Self {
            interfaces,
            build: crate::BUILD_ID.to_owned(),
        }
    }

    /// What the bridge offers now.
    pub fn set_interfaces(&mut self, interfaces: Vec<BridgeInterface>) {
        self.interfaces = interfaces;
    }

    /// Says hello as `build` (the bridge's own, see [`SelfFile::build`]).
    pub fn with_build(mut self, build: String) -> Self {
        self.build = build;
        self
    }

    /// The first message on the socket.
    pub fn hello(&self, host_name: &str, token: Option<String>) -> ClientMessage {
        ClientMessage::BridgeHello {
            build: self.build.clone(),
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
            ServerMessage::BridgeMicsScreen { open } => vec![Effect::Show(
                if open {
                    "Mics screen open"
                } else {
                    "Mics screen closed"
                }
                .into(),
            )],
            ServerMessage::BridgeDetecting { channels } => {
                vec![Effect::Show(format!(
                    "Detecting {} channel(s)",
                    channels.len()
                ))]
            }
            ServerMessage::Rejected { reason } => {
                vec![Effect::Show(format!("The server refused: {reason:?}"))]
            }
            _ => vec![],
        }
    }

    fn channel_line(&self, channel: &BridgeChannelSettings) -> String {
        let name = if channel.name.is_empty() {
            match self
                .interfaces
                .iter()
                .find(|i| i.device_name == channel.device_name)
            {
                Some(interface) => default_name(interface, channel.channel),
                None => format!("{} · Input {}", channel.device_name, channel.channel + 1),
            }
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

/// What the connection loop did, for the window.
#[derive(Debug, Clone, Copy)]
pub enum Event<'a> {
    /// A connection attempt to `server` starts.
    Connecting { server: &'a str },
    /// The attempt or the connection failed; another follows.
    NotConnected { error: &'a anyhow::Error },
    /// The connection ended; another attempt follows.
    Disconnected,
    /// A message from the server.
    Received(&'a ServerMessage),
    /// The server is of another build: the bridge downloads it and
    /// restarts into it.
    Updating { build: &'a str },
    /// The server is of another build and the bridge cannot replace its
    /// own file: it does not connect.
    BuildMismatch(&'a Mismatch),
    /// What the bridge sees changed: the interfaces it offers and those not
    /// in Pro Audio (each a profile message).
    Offered {
        interfaces: &'a [BridgeInterface],
        not_pro_audio: &'a [NotProAudio],
    },
    /// An interface was opened or closed.
    InterfaceOpen { device_name: &'a str, open: bool },
    /// The level of each channel of an open interface (index = hardware
    /// channel) over the last [`LEVEL_INTERVAL`], in dBFS.
    Levels {
        device_name: &'a str,
        levels_dbfs: &'a [f64],
    },
}

/// Whoever shows what the bridge is doing.
pub trait Report: Send {
    /// Something happened.
    fn event(&mut self, _event: Event<'_>) {}
    /// The same, as an English status line (headless prints these).
    fn line(&mut self, _line: &str) {}
}

/// Headless: prints every status line to stdout.
pub struct PrintLines;

impl Report for PrintLines {
    fn line(&mut self, line: &str) {
        println!("{line}");
    }
}

/// One interface the bridge reads (for `--wav`, a WAV file).
pub trait Input: Send {
    /// What the bridge offers the server.
    fn interface(&self) -> &BridgeInterface;
    /// Its stream's sample rate, in Hz.
    fn sample_rate(&self) -> f64;
    /// Called about every [`CAPTURE_INTERVAL`] while the interface is
    /// open, at `now_ms` on the bridge's monotonic clock (the first call
    /// after [`Input::close`] opens a new stream): every frame captured
    /// since the last call, each with every channel (index = hardware
    /// channel), interleaved.
    fn read(&mut self, now_ms: f64) -> Vec<f32>;
    /// The input delay its capture backend reports for `channel`, in ms;
    /// `None` when it reports none (always for a WAV file).
    fn input_delay_ms(&self, _channel: u32) -> Option<f64> {
        None
    }
    /// The interface is no longer needed.
    fn close(&mut self) {}
    /// What tells this input from another for the same interface: an
    /// input that comes back with the same identity is kept as it is (its
    /// stream stays open), any other is replaced.
    fn identity(&self) -> String {
        format!("{:?}", self.interface())
    }
}

/// What the bridge offers, as it changes.
pub struct Offered {
    pub inputs: Vec<Box<dyn Input>>,
    /// The interfaces it sees that are not in Pro Audio.
    pub not_pro_audio: Vec<NotProAudio>,
}

/// Where the bridge's inputs come from: a fixed list (`--wav`) or the
/// sound server, watched ([`crate::watch`]).
pub trait Offer: Send {
    /// What is offered, if it changed since the last call (the first call
    /// always answers). Called about every [`CAPTURE_INTERVAL`]; must not
    /// block.
    fn changed(&mut self) -> Option<Offered>;
    /// Switch to Pro Audio was pressed on the Stage for `device_name`.
    fn switch_to_pro_audio(&mut self, _device_name: &str) {}
}

/// A fixed list of inputs, offered once.
struct Fixed(Option<Vec<Box<dyn Input>>>);

impl Offer for Fixed {
    fn changed(&mut self) -> Option<Offered> {
        Some(Offered {
            inputs: self.0.take()?,
            not_pro_audio: Vec::new(),
        })
    }
}

/// One offered input, with the frames it captured since the last levels
/// while it is open (`None` while closed).
type Entry = (Box<dyn Input>, Option<Vec<f32>>);

/// The inputs offered now.
#[derive(Default)]
struct Inputs {
    entries: Vec<Entry>,
    not_pro_audio: Vec<NotProAudio>,
}

impl Inputs {
    fn interfaces(&self) -> Vec<BridgeInterface> {
        self.entries
            .iter()
            .map(|(input, _)| input.interface().clone())
            .collect()
    }

    /// What the server is told the bridge sees.
    fn message(&self) -> ClientMessage {
        ClientMessage::BridgeInterfaces {
            interfaces: self.interfaces(),
            not_pro_audio: self.not_pro_audio.clone(),
        }
    }

    /// Takes `offered` in: an input of the same identity as one offered
    /// before is kept (open or not); the others are new and closed. Returns
    /// the device names of open inputs that went, now closed.
    fn replace(&mut self, offered: Offered) -> Vec<String> {
        let mut old: Vec<Option<Entry>> = std::mem::take(&mut self.entries)
            .into_iter()
            .map(Some)
            .collect();
        for input in offered.inputs {
            let identity = input.identity();
            let kept = old
                .iter_mut()
                .find(|entry| {
                    entry
                        .as_ref()
                        .is_some_and(|(o, _)| o.identity() == identity)
                })
                .and_then(Option::take);
            self.entries.push(kept.unwrap_or((input, None)));
        }
        self.not_pro_audio = offered.not_pro_audio;
        old.into_iter()
            .flatten()
            .filter_map(|(mut input, stream)| {
                input.close();
                stream.map(|_| input.interface().device_name.clone())
            })
            .collect()
    }

    /// Every input is closed (not connected).
    fn close_all(&mut self) {
        for (input, stream) in &mut self.entries {
            input.close();
            *stream = None;
        }
    }
}

/// What to tell the server about `input`'s input delays when it opens:
/// nothing when its capture backend reports none.
pub fn input_delays(input: &dyn Input) -> Option<ClientMessage> {
    let interface = input.interface();
    let delays: Vec<BridgeInputDelay> = (0..interface.channels)
        .filter_map(|channel| {
            Some(BridgeInputDelay {
                device_name: interface.device_name.clone(),
                channel,
                delay_ms: input.input_delay_ms(channel)?,
            })
        })
        .collect();
    (!delays.is_empty()).then_some(ClientMessage::BridgeInputDelays { delays })
}

/// Why [`run`] stopped connecting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    /// The bridge's file at this path is now the server's build: restart
    /// into it ([`update::restart`]).
    Updated(std::path::PathBuf),
    /// The server is of another build and the bridge cannot replace itself.
    BuildMismatch(Mismatch),
}

/// Connects to the server in `config` and stays connected, connecting again
/// whenever the connection ends. Returns when the bridge must restart or
/// cannot run the server's build ([`Ended`]), or on an error no retry fixes.
pub async fn run(config: ConfigDir, inputs: Vec<Box<dyn Input>>) -> anyhow::Result<Ended> {
    run_reporting(config, inputs, &mut PrintLines).await
}

/// [`run`], telling `report` what happens.
pub async fn run_reporting(
    config: ConfigDir,
    inputs: Vec<Box<dyn Input>>,
    report: &mut dyn Report,
) -> anyhow::Result<Ended> {
    run_offered(config, Box::new(Fixed(Some(inputs))), report).await
}

/// [`run_reporting`] with inputs that change as `offer` says (a profile
/// changed, an interface came or went), telling the server each time.
pub async fn run_offered(
    config: ConfigDir,
    mut offer: Box<dyn Offer>,
    report: &mut dyn Report,
) -> anyhow::Result<Ended> {
    let server = config.server()?;
    let url = bridge_socket_url(&server)?;
    let me = SelfFile::current()?;
    let build = me.build();
    let mut inputs = Inputs::default();
    let mut joining = Joining::new(Vec::new()).with_build(build.clone());
    take_offered(offer.as_mut(), &mut inputs, &mut joining, report);
    let host_name = host_name();
    let clock = MonotonicClock::new();
    let mut attempt = 0;
    loop {
        report.event(Event::Connecting { server: &server });
        report.line(&format!("Connecting to {server}"));
        let ran = session(
            &config,
            &url,
            &mut joining,
            &host_name,
            &mut inputs,
            offer.as_mut(),
            &clock,
            report,
        )
        .await;
        let ran = match ran {
            Ok(Session::UpdateTo(server_build)) => {
                match update::plan(&build, &server_build, &server, me.can_replace()) {
                    // Told to update to its own build: try again.
                    Plan::Connect => Ok(()),
                    Plan::Update { build } => {
                        report.event(Event::Updating { build: &build });
                        report.line(&update::updating_line(&build));
                        let updated = match update::download(&server).await {
                            Ok((binary, published)) => me.replace(&binary, &published),
                            Err(error) => Err(error),
                        };
                        match updated {
                            Ok(()) => return Ok(Ended::Updated(me.path().to_owned())),
                            // A bad copy is discarded: not connected, and
                            // the next hello tries again.
                            Err(error) => Err(error),
                        }
                    }
                    Plan::Mismatch(mismatch) => {
                        report.event(Event::BuildMismatch(&mismatch));
                        report.line(&mismatch.message());
                        report.line(&format!(
                            "To update it, run this on this computer: {}",
                            mismatch.install_command
                        ));
                        return Ok(Ended::BuildMismatch(mismatch));
                    }
                }
            }
            Ok(Session::Closed) => Ok(()),
            Err(error) => Err(error),
        };
        match ran {
            Ok(()) => {
                report.event(Event::Disconnected);
                report.line("Disconnected");
                attempt = 0;
            }
            Err(error) => {
                report.event(Event::NotConnected { error: &error });
                report.line(&format!("Not connected: {error:#}"));
            }
        }
        // Not connected, so nothing is needed.
        inputs.close_all();
        tokio::time::sleep(RETRY[attempt.min(RETRY.len() - 1)]).await;
        take_offered(offer.as_mut(), &mut inputs, &mut joining, report);
        attempt += 1;
    }
}

/// Takes in what `offer` offers now, if it changed: shown, and the device
/// names of open inputs that went (closed now) returned. `None` when
/// nothing changed.
fn take_offered(
    offer: &mut dyn Offer,
    inputs: &mut Inputs,
    joining: &mut Joining,
    report: &mut dyn Report,
) -> Option<Vec<String>> {
    let offered = offer.changed()?;
    let gone = inputs.replace(offered);
    let interfaces = inputs.interfaces();
    joining.set_interfaces(interfaces.clone());
    report.event(Event::Offered {
        interfaces: &interfaces,
        not_pro_audio: &inputs.not_pro_audio,
    });
    for line in profile_lines(&inputs.not_pro_audio) {
        report.line(&line);
    }
    Some(gone)
}

/// Sends one message on `socket`.
async fn send<S>(socket: &mut S, message: &ClientMessage) -> anyhow::Result<()>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    socket
        .send(Message::text(serde_json::to_string(message)?))
        .await?;
    Ok(())
}

/// How one connection ended.
enum Session {
    /// The connection closed.
    Closed,
    /// The server is of this other build.
    UpdateTo(String),
}

/// The server's build, if `text` is its answer to a hello of another build
/// ([`ServerMessage::BridgeUpdate`]). Read as plain JSON, not as the whole
/// [`ServerMessage`], so a bridge of any build understands it however much
/// the other messages changed.
pub fn update_notice(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("type")?.as_str()? != "bridgeUpdate" {
        return None;
    }
    Some(value.get("build")?.as_str()?.to_owned())
}

/// One connection, until it ends.
#[expect(clippy::too_many_arguments, reason = "one connection's whole context")]
async fn session(
    config: &ConfigDir,
    url: &str,
    joining: &mut Joining,
    host_name: &str,
    inputs: &mut Inputs,
    offer: &mut dyn Offer,
    clock: &MonotonicClock,
    report: &mut dyn Report,
) -> anyhow::Result<Session> {
    let (mut socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .with_context(|| format!("connecting to {url}"))?;
    send(&mut socket, &joining.hello(host_name, config.token())).await?;
    // What it sees, profile messages included, right after the hello.
    send(&mut socket, &inputs.message()).await?;
    let mut metering = Metering::default();
    // Fresh per connection: every Local mic syncs afresh.
    let mut detecting = Detecting::new();
    let mut connected = false;
    let mut capture = tokio::time::interval(CAPTURE_INTERVAL);
    capture.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut tick = tokio::time::interval(LEVEL_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            message = socket.next() => {
                let Some(message) = message else { return Ok(Session::Closed) };
                let Message::Text(text) = message? else {
                    continue;
                };
                if let Some(build) = update_notice(&text) {
                    return Ok(Session::UpdateTo(build));
                }
                // Same build as the server, so every message parses; anything
                // else is not for the bridge.
                let Ok(message) = serde_json::from_str::<ServerMessage>(&text) else {
                    continue;
                };
                match &message {
                    ServerMessage::BridgeConnected { .. } => connected = true,
                    ServerMessage::BridgeSwitchProfile { device_name } => {
                        offer.switch_to_pro_audio(device_name);
                    }
                    ServerMessage::BridgeChannels { channels } => metering.set_channels(channels),
                    ServerMessage::BridgeMicsScreen { open } => metering.set_mics_screen_open(*open),
                    _ => {}
                }
                detecting.received(&message, clock.now_ms());
                report.event(Event::Received(&message));
                for effect in joining.received(message) {
                    match effect {
                        Effect::Show(line) => report.line(&line),
                        Effect::KeepToken(token) => {
                            config.save_token(&token)?;
                            report.line(&format!(
                                "Approved: the token is kept in {}",
                                config.path().display()
                            ));
                        }
                    }
                }
            }
            _ = capture.tick() => {
                if let Some(gone) = take_offered(offer, inputs, joining, report) {
                    for device_name in gone {
                        report.event(Event::InterfaceOpen { device_name: &device_name, open: false });
                        report.line(&format!("Interface {device_name}: closed"));
                        detecting.closed(&device_name);
                    }
                    send(&mut socket, &inputs.message()).await?;
                }
                if !connected {
                    continue;
                }
                let mut out = Vec::new();
                for (input, stream) in &mut inputs.entries {
                    let interface = input.interface().clone();
                    let device_name = interface.device_name.as_str();
                    let open = metering.is_open(&interface) || detecting.wants(device_name);
                    if open != stream.is_some() {
                        report.event(Event::InterfaceOpen { device_name, open });
                        let state = if open { "open" } else { "closed" };
                        report.line(&format!("Interface {device_name}: {state}"));
                        if open {
                            *stream = Some(Vec::new());
                            detecting.opened(device_name, input.sample_rate(), clock.now_ms());
                            out.extend(input_delays(input.as_ref()));
                        } else {
                            *stream = None;
                            input.close();
                            detecting.closed(device_name);
                        }
                    }
                    if let Some(frames) = stream {
                        let now_ms = clock.now_ms();
                        let block = input.read(now_ms);
                        out.extend(detecting.captured(device_name, &block, interface.channels, now_ms));
                        frames.extend_from_slice(&block);
                    }
                }
                out.extend(detecting.pings(clock.now_ms()));
                for message in &out {
                    send(&mut socket, message).await?;
                }
            }
            _ = tick.tick() => {
                if !connected {
                    continue;
                }
                let mut levels = Vec::new();
                for (input, stream) in &mut inputs.entries {
                    // Nothing read since the last levels: no level yet.
                    let Some(frames) = stream.as_mut().filter(|frames| !frames.is_empty()) else {
                        continue;
                    };
                    let interface = input.interface();
                    let read = channel_levels_dbfs(frames, interface.channels as usize);
                    let zeros = channel_digital_silence(frames, interface.channels as usize);
                    frames.clear();
                    report.event(Event::Levels {
                        device_name: &interface.device_name,
                        levels_dbfs: &read,
                    });
                    levels.extend(metering.levels_to_send(interface, &read, &zeros));
                }
                if !levels.is_empty() {
                    send(&mut socket, &ClientMessage::BridgeLevels { levels }).await?;
                }
            }
        }
    }
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
            usb_id: None,
            twin: false,
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
    fn default_names_say_input_n_or_loopback_n_from_the_known_models_table() {
        let scarlett = BridgeInterface {
            device_name: "alsa_card.usb-Focusrite-00".into(),
            label: "Scarlett 4i4 4th Gen".into(),
            channels: 6,
            usb_id: Some("1235:821a".into()),
            twin: false,
        };
        assert_eq!(default_name(&scarlett, 3), "Scarlett 4i4 4th Gen · Input 4");
        assert_eq!(
            default_name(&scarlett, 4),
            "Scarlett 4i4 4th Gen · Loopback 1"
        );
        assert_eq!(
            default_name(&scarlett, 5),
            "Scarlett 4i4 4th Gen · Loopback 2"
        );
        let unknown = BridgeInterface {
            usb_id: Some("1397:0509".into()),
            label: "UMC404HD 192k".into(),
            ..scarlett
        };
        assert_eq!(default_name(&unknown, 4), "UMC404HD 192k · Input 5");
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
    fn the_mics_screen_is_shown_open_or_closed() {
        assert_eq!(
            wav().received(ServerMessage::BridgeMicsScreen { open: true }),
            vec![Effect::Show("Mics screen open".into())]
        );
        assert_eq!(
            wav().received(ServerMessage::BridgeMicsScreen { open: false }),
            vec![Effect::Show("Mics screen closed".into())]
        );
    }

    /// An interface whose backend reports a delay for channels 1 and 3.
    struct Reporting(BridgeInterface);

    impl Input for Reporting {
        fn interface(&self) -> &BridgeInterface {
            &self.0
        }
        fn sample_rate(&self) -> f64 {
            48_000.0
        }
        fn read(&mut self, _now_ms: f64) -> Vec<f32> {
            Vec::new()
        }
        fn input_delay_ms(&self, channel: u32) -> Option<f64> {
            (channel % 2 == 1).then_some(f64::from(channel) + 0.5)
        }
    }

    #[test]
    fn input_delays_are_reported_per_channel_when_the_backend_reports_them() {
        let interface = BridgeInterface {
            device_name: "alsa_card.usb-X-00".into(),
            label: "Scarlett 4i4".into(),
            channels: 4,
            usb_id: None,
            twin: false,
        };
        let delay = |channel, delay_ms| BridgeInputDelay {
            device_name: "alsa_card.usb-X-00".into(),
            channel,
            delay_ms,
        };
        assert_eq!(
            input_delays(&Reporting(interface)),
            Some(ClientMessage::BridgeInputDelays {
                delays: vec![delay(1, 1.5), delay(3, 3.5)]
            })
        );
    }

    #[test]
    fn a_wav_input_reports_no_input_delay() {
        let audio = crate::wav::WavAudio {
            format: crate::wav::WavFormat {
                channels: 4,
                sample_rate: 48_000,
                bits_per_sample: 16,
                float: false,
            },
            samples: vec![0.0; 16],
        };
        assert_eq!(
            input_delays(&crate::wav::WavInput::new("x.wav".into(), audio)),
            None
        );
    }

    #[test]
    fn detecting_channels_are_shown_as_a_count() {
        let input = |channel| openstar_protocol::BridgeInput {
            device_name: "alsa_card.usb-X-00".into(),
            channel,
        };
        assert_eq!(
            wav().received(ServerMessage::BridgeDetecting {
                channels: vec![input(0), input(2)]
            }),
            vec![Effect::Show("Detecting 2 channel(s)".into())]
        );
    }

    #[test]
    fn the_update_notice_is_read_as_plain_json_so_any_build_reads_it() {
        let sent = serde_json::to_string(&ServerMessage::BridgeUpdate {
            build: "1.4.0".into(),
        })
        .unwrap();
        assert_eq!(update_notice(&sent).as_deref(), Some("1.4.0"));
        assert_eq!(
            update_notice(r#"{"type":"bridgeUpdate","build":"0.9.0","fromLater":1}"#).as_deref(),
            Some("0.9.0")
        );
        let waiting = serde_json::to_string(&ServerMessage::BridgeWaiting {
            code: "4821".into(),
        })
        .unwrap();
        assert_eq!(update_notice(&waiting), None);
        assert_eq!(update_notice("not json"), None);
    }

    #[test]
    fn messages_for_browsers_are_ignored() {
        assert_eq!(wav().received(ServerMessage::StageMoved), vec![]);
    }
}
