//! Reads the cards and sources of the desktop's sound server over the
//! PulseAudio protocol (PipeWire answers it through `pipewire-pulse`), in
//! pure Rust, so the bridge never links `libpulse`. [`read`] authenticates,
//! names itself and lists, with read access only; [`switch_to_pro_audio`]
//! is the one change it ever makes, and only when Switch to Pro Audio is
//! pressed.
//!
//! [`card`] and [`source`] turn the replies into [`crate::discovery`]'s
//! facts; [`Connection`] does the talking.

use std::ffi::{CStr, CString};
use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::time::Duration;

use anyhow::Context as _;
use pulseaudio::protocol::{self, CardInfo, Props, SourceInfo};

use crate::discovery::{Card, Source};

/// How long one reply may take.
const TIMEOUT: Duration = Duration::from_secs(5);

/// A property's value as text, without its trailing NUL.
fn text(props: &Props, key: &str) -> Option<String> {
    let key = CString::new(key).ok()?;
    let bytes = props.get_bytes(key)?;
    let value = CStr::from_bytes_until_nul(bytes)
        .map(CStr::to_bytes)
        .unwrap_or(bytes);
    let value = String::from_utf8_lossy(value).trim().to_owned();
    (!value.is_empty()).then_some(value)
}

/// `0x1235` → `1235`: four lowercase hex digits.
fn usb_hex(value: &str) -> Option<String> {
    let digits = value.trim_start_matches("0x").to_ascii_lowercase();
    (digits.len() == 4 && digits.bytes().all(|b| b.is_ascii_hexdigit())).then_some(digits)
}

/// The facts of one card reply.
pub fn card(info: &CardInfo) -> Card {
    let props = &info.props;
    let usb = text(props, "device.bus").as_deref() == Some("usb");
    let usb_id = usb
        .then(|| {
            let vendor = usb_hex(&text(props, "device.vendor.id")?)?;
            let product = usb_hex(&text(props, "device.product.id")?)?;
            Some(format!("{vendor}:{product}"))
        })
        .flatten();
    let device_name =
        text(props, "device.name").unwrap_or_else(|| info.name.to_string_lossy().into_owned());
    let active_profile = info
        .active_profile
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    let profile_description = info
        .profiles
        .iter()
        .find(|p| Some(p.name.as_c_str()) == info.active_profile.as_deref())
        .and_then(|p| p.description.as_ref())
        .map(|d| d.to_string_lossy().trim().to_owned())
        .filter(|d| !d.is_empty());
    Card {
        index: info.index,
        card_name: info.name.to_string_lossy().into_owned(),
        profile_description,
        description: text(props, "device.description").unwrap_or_else(|| device_name.clone()),
        device_name,
        usb_id,
        serial: text(props, "device.serial"),
        bus_path: text(props, "device.bus-path").or_else(|| text(props, "device.bus_path")),
        active_profile,
    }
}

/// The facts of one source reply.
pub fn source(info: &SourceInfo) -> Source {
    let latency_us = if info.actual_latency > 0 {
        info.actual_latency
    } else {
        info.configured_latency
    };
    Source {
        name: info.name.to_string_lossy().into_owned(),
        card: info.card_index,
        channels: u32::from(info.sample_spec.channels),
        sample_rate: info.sample_spec.sample_rate,
        // Microseconds to ms; µs counts stay far below f64's exact range.
        #[expect(clippy::cast_precision_loss, reason = "µs of latency")]
        latency_ms: (latency_us > 0).then(|| latency_us as f64 / 1000.0),
        monitor: info.monitor_of_sink_index.is_some(),
    }
}

/// Every card and source the sound server lists now.
pub fn read() -> anyhow::Result<(Vec<Card>, Vec<Source>)> {
    Connection::open()?.cards_and_sources()
}

/// Switches card `card_name` to the Pro Audio profile. Only Switch to Pro
/// Audio calls this, never anything on its own. An error is a refusal (an
/// "access denied" in a sandbox, for example): the bridge then shows the
/// `pactl` line instead.
pub fn switch_to_pro_audio(card_name: &str) -> anyhow::Result<()> {
    Connection::open()?.set_card_profile(card_name, crate::discovery::PRO_AUDIO)
}

/// One authenticated, named connection to the sound server.
pub struct Connection {
    socket: BufReader<UnixStream>,
    version: u16,
    sequence: u32,
}

impl Connection {
    /// Connects to the desktop's sound server.
    pub fn open() -> anyhow::Result<Self> {
        let path = pulseaudio::socket_path_from_env()
            .context("no PulseAudio-protocol sound server found (is PipeWire running?)")?;
        let stream = UnixStream::connect(&path)
            .with_context(|| format!("connecting to the sound server at {}", path.display()))?;
        let cookie = pulseaudio::cookie_path_from_env()
            .and_then(|path| std::fs::read(path).ok())
            .unwrap_or_default();
        Self::over(stream, cookie)
    }

    /// Authenticates over `stream` with `cookie` and names the bridge.
    pub fn over(stream: UnixStream, cookie: Vec<u8>) -> anyhow::Result<Self> {
        stream.set_read_timeout(Some(TIMEOUT))?;
        stream.set_write_timeout(Some(TIMEOUT))?;
        let mut connection = Self {
            socket: BufReader::new(stream),
            version: protocol::MAX_VERSION,
            sequence: 0,
        };
        connection.send(&protocol::Command::Auth(protocol::AuthParams {
            version: protocol::MAX_VERSION,
            supports_shm: false,
            supports_memfd: false,
            cookie,
        }))?;
        let (_, auth) = protocol::read_reply_message::<protocol::AuthReply>(
            &mut connection.socket,
            protocol::MAX_VERSION,
        )?;
        connection.version = protocol::MAX_VERSION.min(auth.version);

        let mut props = Props::new();
        props.set(protocol::Prop::ApplicationName, c"OpenStar Mic bridge");
        connection.send(&protocol::Command::SetClientName(props))?;
        protocol::read_reply_message::<protocol::SetClientNameReply>(
            &mut connection.socket,
            connection.version,
        )?;
        Ok(connection)
    }

    fn send(&mut self, command: &protocol::Command) -> anyhow::Result<()> {
        protocol::write_command_message(
            self.socket.get_mut(),
            self.sequence,
            command,
            self.version,
        )?;
        self.sequence += 1;
        Ok(())
    }

    /// Every card and source it lists now.
    pub fn cards_and_sources(&mut self) -> anyhow::Result<(Vec<Card>, Vec<Source>)> {
        self.send(&protocol::Command::GetCardInfoList)?;
        let (_, cards) =
            protocol::read_reply_message::<protocol::CardInfoList>(&mut self.socket, self.version)?;
        self.send(&protocol::Command::GetSourceInfoList)?;
        let (_, sources) = protocol::read_reply_message::<protocol::SourceInfoList>(
            &mut self.socket,
            self.version,
        )?;
        Ok((
            cards.iter().map(card).collect(),
            sources.iter().map(source).collect(),
        ))
    }

    /// Sets card `card_name`'s profile to `profile`. The protocol has no
    /// save flag of its own: the server always saves a profile set this
    /// way (PulseAudio's `pa_card_set_profile(…, save = true)`,
    /// pipewire-pulse's `SPA_PARAM_PROFILE_save = true`), as for `pactl`
    /// and pavucontrol, so WirePlumber restores it after a reboot or replug.
    pub fn set_card_profile(&mut self, card_name: &str, profile: &str) -> anyhow::Result<()> {
        self.send(&protocol::Command::SetCardProfile(
            protocol::SetCardProfileParams {
                card_index: None,
                card_name: Some(CString::new(card_name)?),
                profile_name: CString::new(profile)?,
            },
        ))?;
        protocol::read_ack_message(&mut self.socket).with_context(|| {
            format!("the sound server refused to switch {card_name} to {profile}")
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn props(pairs: &[(&str, &str)]) -> Props {
        let mut props = Props::new();
        for (key, value) in pairs {
            let key = CString::new(*key).unwrap();
            let value = CString::new(*value).unwrap();
            props.set_bytes(key, value.as_bytes_with_nul());
        }
        props
    }

    fn card_info(index: u32, name: &CStr, props: Props, profile: Option<&CStr>) -> CardInfo {
        CardInfo {
            index,
            name: name.to_owned(),
            props,
            owner_module_index: None,
            driver: None,
            ports: Vec::new(),
            profiles: Vec::new(),
            active_profile: profile.map(CStr::to_owned),
        }
    }

    #[test]
    fn a_usb_card_gives_its_name_usb_id_serial_port_and_profile() {
        let info = card_info(
            42,
            c"alsa_card.usb-Focusrite-00",
            props(&[
                ("device.name", "alsa_card.usb-Focusrite-00"),
                ("device.description", "Scarlett 4i4 4th Gen"),
                ("device.bus", "usb"),
                ("device.vendor.id", "0x1235"),
                ("device.product.id", "0x821A"),
                ("device.serial", "Focusrite_Scarlett_4i4_4th_Gen_S46"),
                ("device.bus-path", "pci-0000:00:14.0-usb-0:3:1.0"),
            ]),
            Some(c"pro-audio"),
        );
        assert_eq!(
            card(&info),
            Card {
                index: 42,
                device_name: "alsa_card.usb-Focusrite-00".into(),
                description: "Scarlett 4i4 4th Gen".into(),
                usb_id: Some("1235:821a".into()),
                serial: Some("Focusrite_Scarlett_4i4_4th_Gen_S46".into()),
                bus_path: Some("pci-0000:00:14.0-usb-0:3:1.0".into()),
                active_profile: Some("pro-audio".into()),
                card_name: "alsa_card.usb-Focusrite-00".into(),
                profile_description: None,
            }
        );
    }

    fn profile(name: &CStr, description: &CStr) -> protocol::CardProfileInfo {
        protocol::CardProfileInfo {
            name: name.to_owned(),
            description: Some(description.to_owned()),
            priority: 0,
            available: 1,
            num_sinks: 1,
            num_sources: 1,
        }
    }

    #[test]
    fn a_card_gives_its_server_name_and_its_active_profile_s_description() {
        let mut info = card_info(
            42,
            c"alsa_card.usb-Focusrite-00",
            props(&[("device.name", "alsa_card.usb-Focusrite-00")]),
            Some(c"output:analog-surround-21+input:analog-surround-21"),
        );
        info.profiles = vec![
            profile(c"pro-audio", c"Pro Audio"),
            profile(
                c"output:analog-surround-21+input:analog-surround-21",
                c"Analog Surround 2.1 Output + Analog Surround 2.1 Input",
            ),
        ];
        let card = card(&info);
        assert_eq!(card.card_name, "alsa_card.usb-Focusrite-00");
        assert_eq!(
            card.profile_description.as_deref(),
            Some("Analog Surround 2.1 Output + Analog Surround 2.1 Input")
        );
    }

    /// A sound server on the other end of a socket pair: answers the
    /// handshake, then one more command with `answer`, and hands back
    /// that command.
    fn fake_server(
        answer: Option<protocol::PulseError>,
    ) -> (UnixStream, std::thread::JoinHandle<protocol::Command>) {
        let (bridge, server) = UnixStream::pair().unwrap();
        let thread = std::thread::spawn(move || {
            let mut socket = BufReader::new(server);
            let version = protocol::MAX_VERSION;
            let (seq, _) = protocol::read_command_message(&mut socket, version).unwrap();
            protocol::write_reply_message(
                socket.get_mut(),
                seq,
                &protocol::AuthReply {
                    version,
                    use_memfd: false,
                    use_shm: false,
                },
                version,
            )
            .unwrap();
            let (seq, _) = protocol::read_command_message(&mut socket, version).unwrap();
            protocol::write_reply_message(
                socket.get_mut(),
                seq,
                &protocol::SetClientNameReply { client_id: 1 },
                version,
            )
            .unwrap();
            let (seq, command) = protocol::read_command_message(&mut socket, version).unwrap();
            match answer {
                None => protocol::write_ack_message(socket.get_mut(), seq).unwrap(),
                Some(error) => protocol::write_error(socket.get_mut(), seq, &error).unwrap(),
            }
            command
        });
        (bridge, thread)
    }

    #[test]
    fn switch_to_pro_audio_sets_the_card_s_profile_by_its_name() {
        let (socket, server) = fake_server(None);
        let mut connection = Connection::over(socket, Vec::new()).unwrap();
        connection
            .set_card_profile("alsa_card.usb-Focusrite-00", crate::discovery::PRO_AUDIO)
            .unwrap();
        assert_eq!(
            server.join().unwrap(),
            protocol::Command::SetCardProfile(protocol::SetCardProfileParams {
                card_index: None,
                card_name: Some(c"alsa_card.usb-Focusrite-00".to_owned()),
                profile_name: c"pro-audio".to_owned(),
            })
        );
    }

    #[test]
    fn a_switch_the_server_refuses_is_an_error() {
        let (socket, server) = fake_server(Some(protocol::PulseError::AccessDenied));
        let mut connection = Connection::over(socket, Vec::new()).unwrap();
        let refused = connection.set_card_profile("alsa_card.usb-Focusrite-00", "pro-audio");
        assert!(refused.is_err());
        server.join().unwrap();
    }

    #[test]
    fn a_card_that_is_not_usb_has_no_usb_id() {
        let info = card_info(
            1,
            c"alsa_card.pci-0000_00_1f.3",
            props(&[
                ("device.bus", "pci"),
                ("device.vendor.id", "0x8086"),
                ("device.product.id", "0x51c8"),
            ]),
            None,
        );
        let card = card(&info);
        assert_eq!(card.usb_id, None);
        assert_eq!(card.device_name, "alsa_card.pci-0000_00_1f.3");
    }
}
