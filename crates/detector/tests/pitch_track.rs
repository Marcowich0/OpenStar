//! The YIN Pitch track detector behind the `TrackDetector` interface, on
//! synthetic 16 kHz signals.

use openstar_detector::{
    FRAME_SECONDS, PitchTrack, TRACK_HOP_LEN, TRACK_SAMPLE_RATE, TRACK_WINDOW_LEN, TrackDetector,
    Yin, track_lag_range,
};
use std::f64::consts::TAU;

const RATE: f64 = 16_000.0;

fn sine(frequency: f64, amplitude: f64, seconds: f64) -> Vec<f32> {
    let len = (seconds * RATE).round() as usize;
    (0..len)
        .map(|n| (amplitude * (TAU * frequency * n as f64 / RATE).sin()) as f32)
        .collect()
}

fn track(samples: &[f32]) -> PitchTrack {
    Yin::new().track(samples, &mut |_| {})
}

#[test]
fn takes_16_khz_with_a_25_ms_window_and_a_10_ms_hop() {
    assert_eq!(TRACK_SAMPLE_RATE, 16_000);
    assert_eq!(TRACK_WINDOW_LEN, 400);
    assert_eq!(TRACK_HOP_LEN, 160);
    assert_eq!(FRAME_SECONDS, 0.01);
}

#[test]
fn frames_are_10_ms_apart() {
    // 1 s of silence, then a tone: the first voiced frame is the first whose
    // 400-sample window reaches into the tone, so frame i starts at i × 10 ms.
    let mut samples = vec![0.0_f32; 16_000];
    samples.extend(sine(220.0, 0.5, 1.0));
    let track = track(&samples);
    assert_eq!(track.frame_seconds, 0.01);
    let first_voiced = track
        .pitch
        .iter()
        .position(|&p| p > 0.0)
        .expect("a voiced frame");
    // Window [i·160, i·160+400) must hold mostly tone to be voiced; frame 100
    // starts exactly at the tone.
    assert!((97..=100).contains(&first_voiced), "{first_voiced}");
    assert!(track.pitch[..95].iter().all(|&p| p == 0.0));
    assert!(track.pitch[100..].iter().all(|&p| p > 0.0));
}

#[test]
fn has_one_frame_per_hop_that_fits_a_window_and_the_longest_lag() {
    // A frame needs its window plus the longest lag (214 samples at 16 kHz).
    assert_eq!(track(&vec![0.0; 400 + 214 - 1]).pitch.len(), 0);
    assert_eq!(track(&vec![0.0; 400 + 214 + 160]).pitch.len(), 1);
    assert_eq!(track(&vec![0.0; 400 + 214 + 160 * 2]).pitch.len(), 2);
    let track = track(&vec![0.0; 16_000]);
    assert_eq!(track.pitch.len(), (16_000 - 400 - 214) / 160);
    assert_eq!(track.clarity.len(), track.pitch.len());
    assert_eq!(track.envelope.len(), track.pitch.len());
}

fn cents(a: f64, b: f64) -> f64 {
    1200.0 * (a / b).log2()
}

/// White noise from the xorshift32 generator of `fixtures/detector/README.md`.
fn white_noise(amplitude: f64, seconds: f64, mut state: u32) -> Vec<f32> {
    let len = (seconds * RATE).round() as usize;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (amplitude * (f64::from(state) / f64::from(u32::MAX) * 2.0 - 1.0)) as f32
        })
        .collect()
}

#[test]
fn searches_lags_for_75_to_700_hz() {
    // floor(16000 / 700) = 22, ceil(16000 / 75) = 214.
    assert_eq!(track_lag_range(16_000.0), (22, 214));
    assert_eq!(track_lag_range(44_100.0), (63, 588));
}

#[test]
fn tones_across_75_to_700_hz_give_their_pitch() {
    for frequency in [
        75.0, 82.41, 110.0, 146.83, 220.0, 329.63, 440.0, 523.25, 659.26, 700.0,
    ] {
        let track = track(&sine(frequency, 0.5, 0.5));
        assert!(!track.pitch.is_empty());
        for (i, &pitch) in track.pitch.iter().enumerate() {
            assert!(pitch > 0.0, "{frequency} Hz: frame {i} unvoiced");
            let off = cents(f64::from(pitch), frequency);
            assert!(
                off.abs() < 5.0,
                "{frequency} Hz: frame {i} at {pitch} Hz ({off:.2} cents)"
            );
        }
    }
}

#[test]
fn a_tone_is_clear() {
    let track = track(&sine(220.0, 0.5, 0.5));
    for &clarity in &track.clarity {
        assert!(clarity > 0.95 && clarity <= 1.0, "{clarity}");
    }
}

#[test]
fn white_noise_stays_unvoiced() {
    let track = track(&white_noise(0.5, 2.0, 0x1234_5678));
    assert!(!track.pitch.is_empty());
    assert!(track.pitch.iter().all(|&p| p == 0.0), "{:?}", track.pitch);
    assert!(track.clarity.iter().all(|&c| c < 0.65));
}

#[test]
fn silence_stays_unvoiced_with_no_clarity() {
    let track = track(&vec![0.0; 16_000]);
    assert!(!track.pitch.is_empty());
    assert!(track.pitch.iter().all(|&p| p == 0.0));
    assert!(track.clarity.iter().all(|&c| c == 0.0));
    assert!(track.envelope.iter().all(|&e| e == 0.0));
}

#[test]
fn the_envelope_is_the_rms_of_each_window() {
    // A full-scale-0.5 sine has an RMS of 0.5 / √2 over whole periods
    // (400 samples hold exactly 10 periods of 400 Hz).
    let track = track(&sine(400.0, 0.5, 0.5));
    for &envelope in &track.envelope {
        assert!(
            (f64::from(envelope) - 0.5 / 2.0_f64.sqrt()).abs() < 1e-4,
            "{envelope}"
        );
    }
}

#[test]
fn frames_below_8_percent_of_the_95th_percentile_envelope_are_unvoiced() {
    // 2 s of a loud tone and 1 s of the same tone at 5 % (below the gate)
    // then 1 s at 12 % (above it). The loud part sets the 95th percentile.
    let mut samples = sine(220.0, 0.5, 2.0);
    samples.extend(sine(220.0, 0.025, 1.0));
    samples.extend(sine(220.0, 0.06, 1.0));
    let track = track(&samples);
    let quiet = 205..295;
    let soft = 305..track.pitch.len();
    for i in quiet {
        assert_eq!(track.pitch[i], 0.0, "frame {i}");
        assert_eq!(track.clarity[i], 0.0, "frame {i}");
        assert!(track.envelope[i] > 0.0, "frame {i}");
    }
    for i in soft {
        assert!(
            cents(f64::from(track.pitch[i]), 220.0).abs() < 5.0,
            "frame {i}"
        );
        assert!(track.clarity[i] > 0.9, "frame {i}");
    }
}

#[test]
fn has_its_own_detector_version_behind_the_trait() {
    let detector: Box<dyn TrackDetector> = Box::new(Yin::new());
    assert_eq!(detector.version(), Yin::VERSION);
    assert_eq!(Yin::VERSION, 1);
}

#[test]
fn reports_progress_up_to_done() {
    let mut reports = Vec::new();
    Yin::new().track(&vec![0.0; 16_000 * 50], &mut |share| reports.push(share));
    assert!(reports.len() > 2, "{reports:?}");
    assert!(reports.windows(2).all(|w| w[0] <= w[1]), "{reports:?}");
    assert_eq!(reports.first(), Some(&0.0));
    assert_eq!(reports.last(), Some(&1.0));
}

#[test]
fn a_short_signal_has_an_empty_track() {
    let track = track(&[]);
    assert!(track.pitch.is_empty() && track.clarity.is_empty() && track.envelope.is_empty());
    assert_eq!(track.frame_seconds, 0.01);
}
