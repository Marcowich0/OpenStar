//! The native sender: turns each Local mic's capture into Pitch readings on
//! the Stage's clock, exactly as a Phone does.
//!
//! Per Local mic (one hardware channel of one interface) it runs the shared
//! [`ReadingMaker`] with the MPM detector, fed with every frame of the
//! capture stream, so a reading's `end_frame` is the stream's frame count,
//! and one remote [`SenderSession`] from `openstar-capture-clock`: the
//! lower-envelope mapping of that frame count onto the bridge's own
//! monotonic clock ([`MonotonicClock`]), and the ping schedule and estimator
//! that sync it to the Stage. Every reading made is sent, voiced or not,
//! once an offset exists for the Stage's current epoch; until then it is
//! dropped.
//!
//! Each Local mic syncs on its own (its pings and pongs carry its
//! [`BridgeInput`]), so the Stage sees every bridge Local mic as one remote
//! Mic, like a Phone. The sender is pure: every time is an input, in ms on
//! the bridge's monotonic clock, and it returns the messages to send.

use std::time::Instant;

use openstar_capture_clock::{Pong, SenderSession};
use openstar_detector::{Mpm, ReadingMaker};
use openstar_protocol::{BridgeInput, ClientMessage, PitchReading};

/// The bridge's own monotonic clock, in ms since it was made (never
/// `SystemTime`, which can jump).
#[derive(Debug, Clone, Copy)]
pub struct MonotonicClock {
    start: Instant,
}

impl Default for MonotonicClock {
    fn default() -> Self {
        Self::new()
    }
}

impl MonotonicClock {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
        }
    }

    /// Now, in ms since this clock was made.
    pub fn now_ms(&self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }
}

struct MicSender {
    input: BridgeInput,
    maker: ReadingMaker<Mpm>,
    session: SenderSession,
}

/// Every capturing Local mic of one bridge.
#[derive(Default)]
pub struct Sender {
    mics: Vec<MicSender>,
}

impl Sender {
    pub fn new() -> Self {
        Self::default()
    }

    /// The Local mics capturing now, in the order they started.
    pub fn capturing(&self) -> impl Iterator<Item = &BridgeInput> {
        self.mics.iter().map(|mic| &mic.input)
    }

    /// Local mic `input` starts capturing (or starts again, on a new
    /// stream) at `now_ms`, at `sample_rate`: a fresh reading maker and frame
    /// mapping, and fast pings. A restart keeps the clock offset: the
    /// Stage's clock has not changed.
    pub fn start(&mut self, input: BridgeInput, sample_rate: f64, now_ms: f64) {
        let maker = ReadingMaker::new(Mpm::new(), sample_rate);
        match self.mics.iter_mut().find(|mic| mic.input == input) {
            Some(mic) => {
                mic.maker = maker;
                mic.session.start_capture(now_ms);
            }
            None => {
                let mut session = SenderSession::remote();
                session.start_capture(now_ms);
                self.mics.push(MicSender {
                    input,
                    maker,
                    session,
                });
            }
        }
    }

    /// Local mic `input` stops capturing: no more readings or pings.
    pub fn stop(&mut self, input: &BridgeInput) {
        self.mics.retain(|mic| &mic.input != input);
    }

    /// One block of Local mic `input`'s mono samples, the next frames of its
    /// stream, handled at `handled_ms`: the reading to send, if one was due
    /// and the Stage's clock offset is known. Ignored for a Local mic that
    /// is not capturing.
    pub fn push_block(
        &mut self,
        input: &BridgeInput,
        block: &[f32],
        handled_ms: f64,
    ) -> Option<ClientMessage> {
        let mic = self.mics.iter_mut().find(|mic| &mic.input == input)?;
        let made = mic.maker.push_block(block)?;
        // The mapping learns from every reading, sent or not.
        let capture_ms =
            mic.session
                .stamp(made.end_frame as f64, mic.maker.sample_rate(), handled_ms)?;
        Some(ClientMessage::PitchReading {
            reading: PitchReading {
                capture_ms,
                pitch: made.pitch,
                clarity: made.clarity,
                loudness: made.loudness_dbfs,
            },
            input: Some(mic.input.clone()),
        })
    }

    /// One block of an interface's interleaved samples (`channels` per
    /// frame), handled at `handled_ms`: each capturing Local mic of
    /// `device_name` gets its own channel; the readings to send.
    pub fn push_interleaved(
        &mut self,
        device_name: &str,
        interleaved: &[f32],
        channels: u32,
        handled_ms: f64,
    ) -> Vec<ClientMessage> {
        let width = channels.max(1) as usize;
        let wanted: Vec<BridgeInput> = self
            .mics
            .iter()
            .filter(|mic| mic.input.device_name == device_name && mic.input.channel < channels)
            .map(|mic| mic.input.clone())
            .collect();
        wanted
            .iter()
            .filter_map(|input| {
                let mono: Vec<f32> = interleaved
                    .iter()
                    .skip(input.channel as usize)
                    .step_by(width)
                    .copied()
                    .collect();
                self.push_block(input, &mono, handled_ms)
            })
            .collect()
    }

    /// The clock pings due at `now_ms`, one per Local mic whose ping is due.
    pub fn poll_pings(&mut self, now_ms: f64) -> Vec<ClientMessage> {
        self.mics
            .iter_mut()
            .filter_map(|mic| {
                let t0 = mic.session.poll_ping(now_ms)?;
                Some(ClientMessage::ClockPing {
                    t0,
                    input: Some(mic.input.clone()),
                })
            })
            .collect()
    }

    /// When the next ping of any Local mic is due, for a timer.
    pub fn next_ping_at(&self) -> Option<f64> {
        self.mics
            .iter()
            .filter_map(|mic| mic.session.next_ping_at())
            .reduce(f64::min)
    }

    /// The Stage's pong for Local mic `input`, handled at `t1`.
    pub fn receive_pong(&mut self, input: &BridgeInput, t0: f64, ts: f64, epoch: f64, t1: f64) {
        if let Some(mic) = self.mics.iter_mut().find(|mic| &mic.input == input) {
            mic.session.receive_pong(Pong { t0, t1, ts, epoch });
        }
    }

    /// The connection to the server was made again at `now_ms`: every
    /// Local mic syncs afresh and sends nothing until it has a new offset.
    pub fn restart_sync(&mut self, now_ms: f64) {
        for mic in &mut self.mics {
            mic.session.restart_sync(now_ms);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 48_000.0;
    /// Frames per block: 10 ms, so every block after the first window
    /// makes a reading.
    const BLOCK: usize = 480;

    fn input(channel: u32) -> BridgeInput {
        BridgeInput {
            device_name: "alsa_card.usb-X-00".into(),
            channel,
        }
    }

    /// `frames` of a 440 Hz sine, starting at frame `from`.
    fn tone(from: usize, frames: usize) -> Vec<f32> {
        (from..from + frames)
            .map(|n| (0.5 * (2.0 * std::f64::consts::PI * 440.0 * n as f64 / RATE).sin()) as f32)
            .collect()
    }

    /// Feeds `blocks` blocks of the tone to `mic`, the block ending at frame
    /// f handled at `f / 48 + delay(block)` ms; returns what is to be sent.
    fn feed(
        sender: &mut Sender,
        mic: &BridgeInput,
        first_block: usize,
        blocks: usize,
        delay: impl Fn(usize) -> f64,
    ) -> Vec<ClientMessage> {
        (first_block..first_block + blocks)
            .filter_map(|b| {
                let end = (b + 1) * BLOCK;
                let handled = end as f64 / RATE * 1000.0 + delay(b);
                sender.push_block(mic, &tone(b * BLOCK, BLOCK), handled)
            })
            .collect()
    }

    fn readings(sent: &[ClientMessage]) -> Vec<(PitchReading, BridgeInput)> {
        sent.iter()
            .map(|message| match message {
                ClientMessage::PitchReading {
                    reading,
                    input: Some(input),
                } => (*reading, input.clone()),
                other => panic!("expected a bridge reading, got {other:?}"),
            })
            .collect()
    }

    /// Answers the first ping due at `now` for `mic` as a Stage whose clock
    /// is `offset` ahead, over a round trip of `round_trip` ms.
    fn sync(sender: &mut Sender, mic: &BridgeInput, now: f64, offset: f64, round_trip: f64) {
        let pings = sender.poll_pings(now);
        let t0 = pings
            .iter()
            .find_map(|ping| match ping {
                ClientMessage::ClockPing { t0, input: Some(i) } if i == mic => Some(*t0),
                _ => None,
            })
            .expect("a ping is due");
        let ts = t0 + round_trip / 2.0 + offset;
        sender.receive_pong(mic, t0, ts, 1.7e12, t0 + round_trip);
    }

    #[test]
    fn nothing_is_sent_before_an_offset_exists_for_the_stages_epoch() {
        let mut sender = Sender::new();
        sender.start(input(0), RATE, 0.0);
        assert!(feed(&mut sender, &input(0), 0, 50, |_| 3.0).is_empty());
    }

    #[test]
    fn a_reading_is_stamped_at_its_window_centre_on_the_stages_clock() {
        let mut sender = Sender::new();
        let mic = input(1);
        sender.start(mic.clone(), RATE, 0.0);
        sync(&mut sender, &mic, 0.0, 10_000.0, 4.0);
        // Every block is handled 3 ms after its last frame, one 9 ms late:
        // the lower envelope keeps 3 ms.
        let sent = feed(
            &mut sender,
            &mic,
            0,
            20,
            |b| if b == 10 { 9.0 } else { 3.0 },
        );
        let sent = readings(&sent);
        // The window fills with the fifth block (2400 frames ≥ 2048):
        // readings from there on, one per block.
        assert_eq!(sent.len(), 16);
        let (last, from) = &sent[15];
        assert_eq!(from, &mic);
        // Ends at frame 9600 = 200 ms; centre 1024 frames (21.333 ms)
        // earlier; +3 ms mapping; +10 s offset.
        let expected = 200.0 + 3.0 - 1024.0 / 48.0 + 10_000.0;
        assert!(
            (last.capture_ms - expected).abs() < 1e-6,
            "{}",
            last.capture_ms
        );
        // The detector heard the A4 tone.
        assert!((last.pitch.unwrap() - 69.0).abs() < 0.1);
        assert!(last.clarity > 0.9);
    }

    #[test]
    fn each_local_mic_syncs_and_pings_on_its_own() {
        let mut sender = Sender::new();
        sender.start(input(0), RATE, 0.0);
        sender.start(input(2), RATE, 0.0);
        let pings = sender.poll_pings(0.0);
        assert_eq!(
            pings,
            vec![
                ClientMessage::ClockPing {
                    t0: 0.0,
                    input: Some(input(0))
                },
                ClientMessage::ClockPing {
                    t0: 0.0,
                    input: Some(input(2))
                },
            ]
        );
        sender.receive_pong(&input(2), 0.0, 502.0, 1.7e12, 4.0);
        assert!(feed(&mut sender, &input(0), 0, 10, |_| 3.0).is_empty());
        assert_eq!(feed(&mut sender, &input(2), 0, 10, |_| 3.0).len(), 6);
        // Fast pings: the next one 200 ms later.
        assert_eq!(sender.next_ping_at(), Some(200.0));
    }

    #[test]
    fn interleaved_blocks_reach_each_capturing_channel_alone() {
        let mut sender = Sender::new();
        sender.start(input(1), RATE, 0.0);
        sync(&mut sender, &input(1), 0.0, 0.0, 2.0);
        let mut sent = Vec::new();
        for b in 0..8 {
            // Channel 0 silent, channel 1 the tone.
            let interleaved: Vec<f32> = tone(b * BLOCK, BLOCK)
                .into_iter()
                .flat_map(|s| [0.0, s])
                .collect();
            let handled = ((b + 1) * BLOCK) as f64 / 48.0 + 3.0;
            sent.extend(sender.push_interleaved("alsa_card.usb-X-00", &interleaved, 2, handled));
        }
        let sent = readings(&sent);
        assert_eq!(sent.len(), 4);
        assert!(
            sent.iter()
                .all(|(r, i)| i == &input(1) && r.pitch.is_some())
        );
    }

    #[test]
    fn a_reconnect_drops_readings_until_the_next_pong() {
        let mut sender = Sender::new();
        let mic = input(0);
        sender.start(mic.clone(), RATE, 0.0);
        sync(&mut sender, &mic, 0.0, 50.0, 4.0);
        assert_eq!(feed(&mut sender, &mic, 0, 10, |_| 3.0).len(), 6);
        sender.restart_sync(100.0);
        assert!(feed(&mut sender, &mic, 10, 5, |_| 3.0).is_empty());
        // The next ping (fast: 200 ms after the last) brings a new offset.
        sync(&mut sender, &mic, 200.0, 50.0, 4.0);
        assert_eq!(feed(&mut sender, &mic, 15, 5, |_| 3.0).len(), 5);
    }

    #[test]
    fn a_stopped_local_mic_sends_nothing() {
        let mut sender = Sender::new();
        let mic = input(0);
        sender.start(mic.clone(), RATE, 0.0);
        sync(&mut sender, &mic, 0.0, 0.0, 4.0);
        sender.stop(&mic);
        assert!(feed(&mut sender, &mic, 0, 10, |_| 3.0).is_empty());
        assert!(sender.poll_pings(1000.0).is_empty());
        assert_eq!(sender.capturing().count(), 0);
    }
}
