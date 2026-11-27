//! The Pitch track: what OpenStar hears in a Song's own audio, one frame every
//! 10 ms, used only to fix the Song's timing (Auto-fit and the Timing editor).
//!
//! # Why this is YIN and not the live MPM detector
//!
//! The Pitch track is computed with YIN, on purpose, while a Mic's Pitch
//! readings use the McLeod Pitch Method ([`crate::Mpm`]). Do not "fix" the
//! mismatch:
//!
//! - The Pitch track never scores; it only has to say where the singing is in
//!   a mixed recording (voice over instruments), so a Song's Notes can be
//!   matched to it.
//! - YIN is the detector with evidence for that job: on the owner's Library
//!   case (Don McLean - Vincent) it took the "notes on the singing" share from
//!   15 % to 62 % in the timing-editor prototype, whose `pitch-worker.js` this
//!   ports with its parameters.
//! - The live detector is tuned for one clean voice into a Mic, at low
//!   latency, and is shared with the browser's `AudioWorklet`.
//!
//! A better Pitch track detector replaces [`Yin`] behind [`TrackDetector`] and
//! takes a new [`TrackDetector::version`], so cached Pitch tracks made by the
//! old one are recomputed.

/// The sample rate a [`TrackDetector`] takes: 16 kHz mono.
pub const TRACK_SAMPLE_RATE: u32 = 16_000;
/// The analysis window: 25 ms at 16 kHz.
pub const TRACK_WINDOW_LEN: usize = 400;
/// The hop between frames: 10 ms at 16 kHz.
pub const TRACK_HOP_LEN: usize = 160;
/// The time between two frames of a [`PitchTrack`], in seconds.
pub const FRAME_SECONDS: f64 = 0.01;

/// The lowest pitch YIN reports, in Hz.
const LOWEST_HZ: f64 = 75.0;
/// The highest pitch YIN reports, in Hz.
const HIGHEST_HZ: f64 = 700.0;
/// A frame whose envelope is below this share of the Song's 95th-percentile
/// envelope is unvoiced.
const GATE_SHARE: f64 = 0.08;
/// The percentile of the whole Song's envelope the gate is measured against.
const GATE_PERCENTILE: f64 = 0.95;
/// The first lag whose CMNDF is below this is the period.
const YIN_THRESHOLD: f64 = 0.35;

/// The Pitch track of one Song: frame `i` is the window that starts at
/// `i × frame_seconds` of the audio. The three lists have the same length.
#[derive(Debug, Clone, PartialEq)]
pub struct PitchTrack {
    /// Seconds between frames; always [`FRAME_SECONDS`].
    pub frame_seconds: f64,
    /// The heard pitch in Hz, 0 for an unvoiced frame.
    pub pitch: Vec<f32>,
    /// How clearly the frame is pitched, from 0 to 1; 0 below the envelope gate.
    pub clarity: Vec<f32>,
    /// The RMS of the frame's window (the waveform the Timing editor draws).
    pub envelope: Vec<f32>,
}

/// A detector that turns a whole Song's audio into a [`PitchTrack`].
///
/// Unlike the live [`crate::Detector`], it sees the whole Song at once (its
/// gate is relative to the Song's own loudness) and carries a version: a
/// cached Pitch track is valid only for the detector version that made it.
pub trait TrackDetector {
    /// Identifies this detector and its parameters. A change in what the
    /// detector produces must come with a new version.
    fn version(&self) -> u32;

    /// The Pitch track of `samples`, mono at [`TRACK_SAMPLE_RATE`].
    /// `progress` is called now and then with the share done (0 to 1), and
    /// with 1 at the end.
    fn track(&mut self, samples: &[f32], progress: &mut dyn FnMut(f64)) -> PitchTrack;
}

/// YIN, ported from the timing-editor prototype's `pitch-worker.js`.
#[derive(Debug, Default)]
pub struct Yin {
    difference: Vec<f64>,
    cmndf: Vec<f64>,
}

impl Yin {
    /// This implementation's detector version.
    pub const VERSION: u32 = 1;

    pub fn new() -> Self {
        Self::default()
    }
}

/// The lag range YIN searches at `sample_rate`: `floor(sr / 700)` to
/// `ceil(sr / 75)` samples, both included.
pub fn track_lag_range(sample_rate: f64) -> (usize, usize) {
    (
        (sample_rate / HIGHEST_HZ).floor() as usize,
        (sample_rate / LOWEST_HZ).ceil() as usize,
    )
}

/// How many frames a `len`-sample signal has: each needs its window plus the
/// longest lag after its start.
fn frame_count(len: usize, max_lag: usize) -> usize {
    len.saturating_sub(TRACK_WINDOW_LEN + max_lag) / TRACK_HOP_LEN
}

/// Frames between two progress reports.
const PROGRESS_EVERY: usize = 2_000;

impl TrackDetector for Yin {
    fn version(&self) -> u32 {
        Self::VERSION
    }

    fn track(&mut self, samples: &[f32], progress: &mut dyn FnMut(f64)) -> PitchTrack {
        let rate = f64::from(TRACK_SAMPLE_RATE);
        let (min_lag, max_lag) = track_lag_range(rate);
        let frames = frame_count(samples.len(), max_lag);

        let envelope: Vec<f64> = (0..frames)
            .map(|f| {
                let window = &samples[f * TRACK_HOP_LEN..][..TRACK_WINDOW_LEN];
                let energy: f64 = window.iter().map(|&v| f64::from(v) * f64::from(v)).sum();
                (energy / TRACK_WINDOW_LEN as f64).sqrt()
            })
            .collect();
        let gate = gate(&envelope);

        let mut pitch = vec![0.0_f32; frames];
        let mut clarity = vec![0.0_f32; frames];
        self.difference.resize(max_lag + 1, 0.0);
        self.cmndf.resize(max_lag + 1, 0.0);
        for f in 0..frames {
            if f % PROGRESS_EVERY == 0 {
                progress(f as f64 / frames as f64);
            }
            if envelope[f] < gate {
                continue;
            }
            let x = &samples[f * TRACK_HOP_LEN..];
            let (frequency, frame_clarity) = self.frame(x, rate, min_lag, max_lag);
            pitch[f] = frequency as f32;
            clarity[f] = frame_clarity as f32;
        }
        progress(1.0);

        PitchTrack {
            frame_seconds: FRAME_SECONDS,
            pitch,
            clarity,
            envelope: envelope.into_iter().map(|e| e as f32).collect(),
        }
    }
}

/// The envelope gate: [`GATE_SHARE`] × the 95th-percentile envelope.
fn gate(envelope: &[f64]) -> f64 {
    if envelope.is_empty() {
        return 0.0;
    }
    let mut sorted = envelope.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len() as f64 * GATE_PERCENTILE).floor() as usize).min(sorted.len() - 1);
    GATE_SHARE * sorted[index]
}

impl Yin {
    /// One gated-in frame starting at `x[0]`: its pitch in Hz (0 when
    /// unvoiced) and its clarity.
    fn frame(&mut self, x: &[f32], rate: f64, min_lag: usize, max_lag: usize) -> (f64, f64) {
        let d = &mut self.difference;
        let cm = &mut self.cmndf;

        // Squared-difference function.
        for (tau, slot) in d.iter_mut().enumerate().skip(1) {
            *slot = (0..TRACK_WINDOW_LEN)
                .map(|j| {
                    let v = f64::from(x[j]) - f64::from(x[j + tau]);
                    v * v
                })
                .sum();
        }

        // Cumulative mean normalised difference.
        cm[0] = 1.0;
        let mut running = 0.0;
        for tau in 1..=max_lag {
            running += d[tau];
            cm[tau] = if running > 0.0 {
                d[tau] * tau as f64 / running
            } else {
                1.0
            };
        }

        let minimum = cm[min_lag..=max_lag]
            .iter()
            .copied()
            .fold(f64::INFINITY, f64::min);
        let clarity = (1.0 - minimum).clamp(0.0, 1.0);

        // The first lag below the threshold, walked down to its local minimum.
        let Some(found) = (min_lag..=max_lag).find(|&tau| cm[tau] < YIN_THRESHOLD) else {
            return (0.0, clarity);
        };
        let mut t = found;
        while t < max_lag && cm[t + 1] < cm[t] {
            t += 1;
        }

        // Parabolic interpolation around it.
        let (a, b) = (cm[t - 1], cm[t]);
        let c = if t < max_lag { cm[t + 1] } else { b };
        let denominator = a - 2.0 * b + c;
        let lag = if denominator != 0.0 {
            t as f64 + (a - c) / (2.0 * denominator)
        } else {
            t as f64
        };
        (rate / lag, clarity)
    }
}
