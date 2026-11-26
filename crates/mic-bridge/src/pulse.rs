//! Reads the cards and sources of the desktop's sound server over the
//! PulseAudio protocol (PipeWire answers it through `pipewire-pulse`), in
//! pure Rust, so the bridge never links `libpulse`. Read access only: it
//! authenticates, names itself and lists; it changes nothing.
//!
//! [`card`] and [`source`] turn the replies into [`crate::discovery`]'s
//! facts; [`read`] does the talking.

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
    Card {
        index: info.index,
        description: text(props, "device.description").unwrap_or_else(|| device_name.clone()),
        device_name,
        usb_id,
        serial: text(props, "device.serial"),
        bus_path: text(props, "device.bus-path").or_else(|| text(props, "device.bus_path")),
        active_profile: info
            .active_profile
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
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
    let path = pulseaudio::socket_path_from_env()
        .context("no PulseAudio-protocol sound server found (is PipeWire running?)")?;
    let stream = UnixStream::connect(&path)
        .with_context(|| format!("connecting to the sound server at {}", path.display()))?;
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    let mut socket = BufReader::new(stream);
    let cookie = pulseaudio::cookie_path_from_env()
        .and_then(|path| std::fs::read(path).ok())
        .unwrap_or_default();
    protocol::write_command_message(
        socket.get_mut(),
        0,
        &protocol::Command::Auth(protocol::AuthParams {
            version: protocol::MAX_VERSION,
            supports_shm: false,
            supports_memfd: false,
            cookie,
        }),
        protocol::MAX_VERSION,
    )?;
    let (_, auth) =
        protocol::read_reply_message::<protocol::AuthReply>(&mut socket, protocol::MAX_VERSION)?;
    let version = protocol::MAX_VERSION.min(auth.version);

    let mut props = Props::new();
    props.set(protocol::Prop::ApplicationName, c"OpenStar Mic bridge");
    protocol::write_command_message(
        socket.get_mut(),
        1,
        &protocol::Command::SetClientName(props),
        version,
    )?;
    protocol::read_reply_message::<protocol::SetClientNameReply>(&mut socket, version)?;

    protocol::write_command_message(
        socket.get_mut(),
        2,
        &protocol::Command::GetCardInfoList,
        version,
    )?;
    let (_, cards) = protocol::read_reply_message::<protocol::CardInfoList>(&mut socket, version)?;
    protocol::write_command_message(
        socket.get_mut(),
        3,
        &protocol::Command::GetSourceInfoList,
        version,
    )?;
    let (_, sources) =
        protocol::read_reply_message::<protocol::SourceInfoList>(&mut socket, version)?;
    Ok((
        cards.iter().map(card).collect(),
        sources.iter().map(source).collect(),
    ))
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
            }
        );
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
