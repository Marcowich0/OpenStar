//! Real capture: each interface's Pro Audio source opened as **one
//! multichannel PipeWire stream** with every channel, raw (32-bit float,
//! the source's own rate and channel count, `AUX0…AUXn` positions,
//! `stream.dont-remix`), so no channel is remixed, resampled or processed.
//! One stream per interface is what keeps every channel alive: one client
//! reading several split sources of one device gets silent channels that
//! still report as live.
//!
//! [`PipeWireInput`] is a [`crate::client::Input`]. While open it runs its
//! stream on a thread of its own with its own PipeWire main loop; the
//! stream's `process` callback appends what it captured to a [`Backlog`]
//! that [`crate::client::Input::read`] drains every 10 ms. Closing quits
//! the loop and joins the thread. [`interfaces`] lists what to offer, from
//! [`crate::pulse`] and [`crate::discovery`].

use std::sync::{Arc, Mutex, Once};
use std::thread::JoinHandle;

use openstar_protocol::bridge::BridgeInterface;
use pipewire as pw;
use pw::spa;

use crate::client::Input;
use crate::discovery::{self, Discovered, Found};

/// The most a backlog keeps, in seconds of audio: a reader that stalls
/// loses the oldest frames, not the newest.
const BACKLOG_SECONDS: usize = 2;

/// What the stream captured since the last read, interleaved.
#[derive(Debug, Default)]
pub struct Backlog {
    samples: Vec<f32>,
    /// At most this many samples are kept (a multiple of the channels).
    limit: usize,
    channels: usize,
}

impl Backlog {
    pub fn new(channels: u32, sample_rate: u32) -> Self {
        let channels = channels.max(1) as usize;
        Self {
            samples: Vec::new(),
            limit: channels * sample_rate as usize * BACKLOG_SECONDS,
            channels,
        }
    }

    /// Appends whole frames of `bytes` (32-bit float, native order); a
    /// partial frame at the end is dropped. Beyond the limit the oldest
    /// whole frames go.
    pub fn push_bytes(&mut self, bytes: &[u8]) {
        let frame_bytes = self.channels * 4;
        let whole = bytes.len() / frame_bytes * frame_bytes;
        self.samples.extend(
            bytes[..whole]
                .as_chunks::<4>()
                .0
                .iter()
                .map(|b| f32::from_ne_bytes(*b)),
        );
        if self.samples.len() > self.limit {
            let excess = self.samples.len() - self.limit;
            self.samples.drain(..excess);
        }
    }

    /// Everything since the last call.
    pub fn take(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.samples)
    }
}

/// The channel positions of a Pro Audio source: `AUX0` to `AUXn-1`.
pub fn aux_positions(channels: u32) -> [u32; spa::sys::SPA_AUDIO_MAX_CHANNELS as usize] {
    let mut positions = [0; spa::sys::SPA_AUDIO_MAX_CHANNELS as usize];
    for (n, position) in positions.iter_mut().take(channels as usize).enumerate() {
        // At most 64 channels.
        *position = spa::sys::SPA_AUDIO_CHANNEL_AUX0 + n as u32;
    }
    positions
}

/// The interfaces the sound server offers now, by the Pro Audio rule.
pub fn interfaces() -> anyhow::Result<Discovered> {
    let (cards, sources) = crate::pulse::read()?;
    Ok(discovery::discover(&cards, &sources))
}

/// A running stream: its thread and how to stop it.
struct Running {
    quit: pw::channel::Sender<()>,
    thread: JoinHandle<()>,
}

/// One interface, captured with PipeWire while open.
pub struct PipeWireInput {
    found: Found,
    backlog: Arc<Mutex<Backlog>>,
    running: Option<Running>,
}

impl PipeWireInput {
    pub fn new(found: Found) -> Self {
        let backlog = Backlog::new(found.interface.channels, found.sample_rate);
        Self {
            found,
            backlog: Arc::new(Mutex::new(backlog)),
            running: None,
        }
    }

    /// Starts the stream on its own thread.
    fn open(&mut self) {
        let (quit, quit_rx) = pw::channel::channel::<()>();
        let found = self.found.clone();
        let backlog = Arc::clone(&self.backlog);
        let thread = std::thread::Builder::new()
            .name(format!("capture {}", found.interface.device_name))
            .spawn(move || {
                if let Err(error) = run_stream(&found, &backlog, quit_rx) {
                    eprintln!(
                        "OpenStar Mic bridge: capturing {}: {error:#}",
                        found.interface.device_name
                    );
                }
            });
        match thread {
            Ok(thread) => self.running = Some(Running { quit, thread }),
            Err(error) => eprintln!("OpenStar Mic bridge: starting capture: {error}"),
        }
    }
}

impl Input for PipeWireInput {
    fn interface(&self) -> &BridgeInterface {
        &self.found.interface
    }

    fn sample_rate(&self) -> f64 {
        f64::from(self.found.sample_rate)
    }

    fn read(&mut self, _now_ms: f64) -> Vec<f32> {
        if self.running.is_none() {
            // A fresh stream: nothing left over from the last one.
            self.backlog
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            self.open();
        }
        self.backlog
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    fn input_delay_ms(&self, channel: u32) -> Option<f64> {
        (channel < self.found.interface.channels)
            .then_some(self.found.latency_ms)
            .flatten()
    }

    /// The node and its format, not only the interface: after a profile
    /// switch the same interface comes back as a new node.
    fn identity(&self) -> String {
        let Found {
            interface,
            node_name,
            sample_rate,
            latency_ms: _,
        } = &self.found;
        format!("{interface:?} {node_name} {sample_rate}")
    }

    fn close(&mut self) {
        if let Some(Running { quit, thread }) = self.running.take() {
            // The loop may have ended already (an error): nothing to stop.
            let _ = quit.send(());
            let _ = thread.join();
        }
    }
}

impl Drop for PipeWireInput {
    fn drop(&mut self) {
        self.close();
    }
}

/// Initialises the PipeWire library once per process.
fn init() {
    static INIT: Once = Once::new();
    INIT.call_once(pw::init);
}

/// Runs one capture stream until `quit` says so.
fn run_stream(
    found: &Found,
    backlog: &Arc<Mutex<Backlog>>,
    quit: pw::channel::Receiver<()>,
) -> anyhow::Result<()> {
    init();
    let main_loop = pw::main_loop::MainLoopRc::new(None)?;
    let context = pw::context::ContextRc::new(&main_loop, None)?;
    let core = context.connect_rc(None)?;
    let _quit = quit.attach(main_loop.loop_(), {
        let main_loop = main_loop.clone();
        move |()| main_loop.quit()
    });

    let props = pw::properties::properties! {
        *pw::keys::MEDIA_TYPE => "Audio",
        *pw::keys::MEDIA_CATEGORY => "Capture",
        *pw::keys::MEDIA_ROLE => "Production",
        *pw::keys::APP_NAME => "OpenStar Mic bridge",
        // The interface's Pro Audio source and nothing else: never moved to
        // another source, never remixed.
        "target.object" => found.node_name.as_str(),
        "node.dont-reconnect" => "true",
        "stream.dont-remix" => "true",
        "channelmix.disable" => "true",
    };
    let stream = pw::stream::StreamBox::new(&core, "OpenStar Mic bridge", props)?;
    let _listener = stream
        .add_local_listener_with_user_data(Arc::clone(backlog))
        .process(|stream, backlog| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let datas = buffer.datas_mut();
            let Some(data) = datas.first_mut() else {
                return;
            };
            let offset = data.chunk().offset() as usize;
            let size = data.chunk().size() as usize;
            if let Some(bytes) = data.data() {
                let end = offset.saturating_add(size).min(bytes.len());
                let start = offset.min(end);
                backlog
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push_bytes(&bytes[start..end]);
            }
        })
        .register()?;

    let mut audio = spa::param::audio::AudioInfoRaw::new();
    audio.set_format(spa::param::audio::AudioFormat::F32LE);
    audio.set_rate(found.sample_rate);
    audio.set_channels(found.interface.channels);
    audio.set_position(aux_positions(found.interface.channels));
    let format = spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(spa::pod::Object {
            type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
            id: spa::param::ParamType::EnumFormat.as_raw(),
            properties: audio.into(),
        }),
    )
    .map_err(|error| anyhow::anyhow!("making the stream format: {error:?}"))?
    .0
    .into_inner();
    let format = spa::pod::Pod::from_bytes(&format)
        .ok_or_else(|| anyhow::anyhow!("the stream format is not a pod"))?;
    stream.connect(
        spa::utils::Direction::Input,
        None,
        pw::stream::StreamFlags::AUTOCONNECT
            | pw::stream::StreamFlags::MAP_BUFFERS
            | pw::stream::StreamFlags::RT_PROCESS,
        &mut [format],
    )?;
    main_loop.run();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_ne_bytes()).collect()
    }

    #[test]
    fn a_backlog_keeps_whole_frames_until_they_are_taken() {
        let mut backlog = Backlog::new(2, 48_000);
        let mut chunk = bytes(&[0.5, -0.5, 0.25, -0.25]);
        // Half a frame more: dropped.
        chunk.extend_from_slice(&1.0f32.to_ne_bytes());
        backlog.push_bytes(&chunk);
        backlog.push_bytes(&bytes(&[1.0, -1.0]));
        assert_eq!(backlog.take(), vec![0.5, -0.5, 0.25, -0.25, 1.0, -1.0]);
        assert_eq!(backlog.take(), Vec::<f32>::new());
    }

    #[test]
    fn a_backlog_that_is_not_read_drops_its_oldest_frames() {
        // 2 channels at 4 Hz: 2 s = 8 frames = 16 samples.
        let mut backlog = Backlog::new(2, 4);
        let frames: Vec<f32> = (0..20).map(|n| n as f32).collect();
        backlog.push_bytes(&bytes(&frames));
        let kept = backlog.take();
        assert_eq!(kept.len(), 16);
        assert_eq!(kept[0], 4.0, "whole frames: still channel 0 first");
        assert_eq!(kept[15], 19.0);
    }

    #[test]
    fn a_pro_audio_stream_asks_for_aux_positions() {
        let positions = aux_positions(6);
        assert_eq!(
            &positions[..7],
            &[4096, 4097, 4098, 4099, 4100, 4101, 0],
            "AUX0..AUX5, then unset"
        );
    }

    #[test]
    fn every_channel_reports_the_source_latency() {
        let input = PipeWireInput::new(Found {
            interface: BridgeInterface {
                device_name: "alsa_card.usb-X-00".into(),
                label: "X".into(),
                channels: 2,
                usb_id: None,
                twin: false,
            },
            node_name: "alsa_input.usb-X-00.pro-input-0".into(),
            sample_rate: 48_000,
            latency_ms: Some(5.3),
        });
        assert_eq!(input.input_delay_ms(0), Some(5.3));
        assert_eq!(input.input_delay_ms(1), Some(5.3));
        assert_eq!(input.input_delay_ms(2), None);
        assert_eq!(input.sample_rate(), 48_000.0);
    }
}
