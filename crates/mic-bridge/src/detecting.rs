//! Which Local mics make Pitch readings, and making them: the server names
//! the bridge's channels that are seated in the Song that plays
//! ([`ServerMessage::BridgeDetecting`]); each of those whose interface is
//! open runs one native detector through the [`Sender`], and stops when the
//! server no longer names it or its interface closes.
//!
//! Captured frames go to the detectors in pieces of [`QUANTUM_FRAMES`], the
//! size of a browser's audio render quantum, so a bridge Local mic makes a
//! reading once at least 10 ms of new samples have arrived, on exactly a
//! Phone's cadence, however large the capture's own blocks are. Pure: every
//! time is an input, in ms on the bridge's monotonic clock.

use std::collections::HashMap;

use openstar_protocol::{BridgeInput, ClientMessage, ServerMessage};

use crate::sender::Sender;

/// Frames per piece handed to a detector: one Web Audio render quantum.
pub const QUANTUM_FRAMES: usize = 128;

/// The detecting state of one connection: a fresh one per connection, so
/// every Local mic syncs afresh after a reconnect.
#[derive(Default)]
pub struct Detecting {
    sender: Sender,
    /// What the server last named.
    wanted: Vec<BridgeInput>,
    /// Open interfaces and their sample rates, by device name.
    open: HashMap<String, f64>,
}

impl Detecting {
    pub fn new() -> Self {
        Self::default()
    }

    /// The Local mics capturing now.
    pub fn capturing(&self) -> impl Iterator<Item = &BridgeInput> {
        self.sender.capturing()
    }

    /// Whether an interface must be open because one of its channels
    /// detects.
    pub fn wants(&self, device_name: &str) -> bool {
        self.wanted
            .iter()
            .any(|input| input.device_name == device_name)
    }

    /// The server named the channels that detect now: those on an open
    /// interface start, those no longer named stop.
    pub fn set(&mut self, channels: Vec<BridgeInput>, now_ms: f64) {
        let gone: Vec<BridgeInput> = self
            .sender
            .capturing()
            .filter(|input| !channels.contains(input))
            .cloned()
            .collect();
        for input in &gone {
            self.sender.stop(input);
        }
        for input in &channels {
            let started = self.sender.capturing().any(|c| c == input);
            if let (false, Some(&rate)) = (started, self.open.get(&input.device_name)) {
                self.sender.start(input.clone(), rate, now_ms);
            }
        }
        self.wanted = channels;
    }

    /// Interface `device_name` opened a new stream at `sample_rate`: its
    /// named channels start, each with a fresh detector.
    pub fn opened(&mut self, device_name: &str, sample_rate: f64, now_ms: f64) {
        self.open.insert(device_name.to_owned(), sample_rate);
        for input in self.wanted.iter().filter(|i| i.device_name == device_name) {
            self.sender.start(input.clone(), sample_rate, now_ms);
        }
    }

    /// Interface `device_name` closed: its channels stop.
    pub fn closed(&mut self, device_name: &str) {
        self.open.remove(device_name);
        for input in self.wanted.iter().filter(|i| i.device_name == device_name) {
            self.sender.stop(input);
        }
    }

    /// Frames an open interface captured (`channels` interleaved), handled
    /// at `now_ms`: the readings to send, every one voiced or not, once the
    /// Stage's clock offset is known.
    pub fn captured(
        &mut self,
        device_name: &str,
        interleaved: &[f32],
        channels: u32,
        now_ms: f64,
    ) -> Vec<ClientMessage> {
        let width = channels.max(1) as usize;
        interleaved
            .chunks(QUANTUM_FRAMES * width)
            .flat_map(|piece| {
                self.sender
                    .push_interleaved(device_name, piece, channels, now_ms)
            })
            .collect()
    }

    /// The clock pings due at `now_ms`.
    pub fn pings(&mut self, now_ms: f64) -> Vec<ClientMessage> {
        self.sender.poll_pings(now_ms)
    }

    /// A message from the server: the Stage's pong for one Local mic is
    /// taken in, handled at `now_ms`; the detecting channels are set.
    pub fn received(&mut self, message: &ServerMessage, now_ms: f64) {
        match message {
            ServerMessage::ClockPong {
                t0,
                ts,
                epoch,
                input: Some(input),
            } => self.sender.receive_pong(input, *t0, *ts, *epoch, now_ms),
            ServerMessage::BridgeDetecting { channels } => self.set(channels.clone(), now_ms),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openstar_protocol::PitchReading;

    const DEVICE: &str = "multichannel.wav";
    const RATE: f64 = 48_000.0;

    fn input(channel: u32) -> BridgeInput {
        BridgeInput {
            device_name: DEVICE.into(),
            channel,
        }
    }

    /// `frames` frames of 2 channels from frame `from`: A4 on channel 0,
    /// silence on channel 1.
    fn frames(from: usize, frames: usize) -> Vec<f32> {
        (from..from + frames)
            .flat_map(|n| {
                let s = 0.5 * (2.0 * std::f64::consts::PI * 440.0 * n as f64 / RATE).sin();
                [s as f32, 0.0]
            })
            .collect()
    }

    fn detected(sent: &[ClientMessage]) -> Vec<(BridgeInput, PitchReading)> {
        sent.iter()
            .filter_map(|message| match message {
                ClientMessage::PitchReading {
                    reading,
                    input: Some(input),
                } => Some((input.clone(), *reading)),
                _ => None,
            })
            .collect()
    }

    /// Answers every ping due at `now_ms` as the Stage would.
    fn sync(detecting: &mut Detecting, now_ms: f64) {
        for ping in detecting.pings(now_ms) {
            let ClientMessage::ClockPing {
                t0,
                input: Some(input),
            } = ping
            else {
                panic!("a bridge ping: {ping:?}");
            };
            detecting.received(
                &ServerMessage::ClockPong {
                    t0,
                    ts: t0 + 1.0 + 5_000.0,
                    epoch: 1.7e12,
                    input: Some(input),
                },
                now_ms + 2.0,
            );
        }
    }

    #[test]
    fn nothing_detects_until_the_server_names_a_channel_of_an_open_interface() {
        let mut detecting = Detecting::new();
        detecting.opened(DEVICE, RATE, 0.0);
        assert!(detecting.pings(0.0).is_empty());
        assert!(
            detecting
                .captured(DEVICE, &frames(0, 4800), 2, 100.0)
                .is_empty()
        );

        // Named while closed: the interface must open, nothing runs yet.
        let mut detecting = Detecting::new();
        detecting.received(
            &ServerMessage::BridgeDetecting {
                channels: vec![input(1)],
            },
            0.0,
        );
        assert!(detecting.wants(DEVICE));
        assert!(!detecting.wants("other.wav"));
        assert_eq!(detecting.capturing().count(), 0);
        detecting.opened(DEVICE, RATE, 10.0);
        assert_eq!(detecting.capturing().collect::<Vec<_>>(), vec![&input(1)]);
    }

    #[test]
    fn one_detector_per_named_channel_reads_its_own_channel_after_the_first_pong() {
        let mut detecting = Detecting::new();
        detecting.opened(DEVICE, RATE, 0.0);
        detecting.set(vec![input(0), input(1)], 0.0);
        // No offset yet: readings are made but none is sent.
        assert!(
            detecting
                .captured(DEVICE, &frames(0, 4800), 2, 100.0)
                .is_empty()
        );
        sync(&mut detecting, 100.0);
        let sent = detected(&detecting.captured(DEVICE, &frames(4800, 4800), 2, 200.0));
        let tone: Vec<_> = sent.iter().filter(|(i, _)| i == &input(0)).collect();
        let silent: Vec<_> = sent.iter().filter(|(i, _)| i == &input(1)).collect();
        assert!(!tone.is_empty());
        assert_eq!(tone.len(), silent.len());
        assert!(
            tone.iter()
                .all(|(_, r)| (r.pitch.unwrap() - 69.0).abs() < 0.1)
        );
        // Every reading is sent, voiced or not.
        assert!(silent.iter().all(|(_, r)| r.pitch.is_none()));
    }

    #[test]
    fn a_large_capture_block_gives_a_reading_per_512_frames_like_a_phone() {
        let mut detecting = Detecting::new();
        detecting.opened(DEVICE, RATE, 0.0);
        detecting.set(vec![input(0)], 0.0);
        sync(&mut detecting, 0.0);
        // The first window fills at frame 2048, which makes the first reading.
        assert_eq!(
            detected(&detecting.captured(DEVICE, &frames(0, 2048), 2, 50.0)).len(),
            1
        );
        // Then one per 4 quanta (512 frames ≥ the 480-frame hop): 10 in
        // one 5120-frame block.
        assert_eq!(
            detected(&detecting.captured(DEVICE, &frames(2048, 5120), 2, 150.0)).len(),
            10
        );
    }

    #[test]
    fn a_channel_stops_when_the_server_no_longer_names_it_or_its_interface_closes() {
        let mut detecting = Detecting::new();
        detecting.opened(DEVICE, RATE, 0.0);
        detecting.set(vec![input(0), input(1)], 0.0);
        detecting.set(vec![input(1)], 50.0);
        assert_eq!(detecting.capturing().collect::<Vec<_>>(), vec![&input(1)]);

        detecting.closed(DEVICE);
        assert_eq!(detecting.capturing().count(), 0);
        assert!(detecting.pings(10_000.0).is_empty());
        // Still named, so the interface opens again, with a fresh detector:
        // its first reading needs a full window of the new stream.
        assert!(detecting.wants(DEVICE));
        detecting.opened(DEVICE, RATE, 20_000.0);
        sync(&mut detecting, 20_000.0);
        assert!(
            detecting
                .captured(DEVICE, &frames(0, 2047), 2, 20_050.0)
                .is_empty()
        );
        assert_eq!(
            detected(&detecting.captured(DEVICE, &frames(2047, 1), 2, 20_051.0)).len(),
            1
        );

        detecting.received(
            &ServerMessage::BridgeDetecting { channels: vec![] },
            30_000.0,
        );
        assert_eq!(detecting.capturing().count(), 0);
        assert!(!detecting.wants(DEVICE));
    }
}
