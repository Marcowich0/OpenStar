//! The McLeod Pitch Method behind the `Detector` interface, on single windows.

use openstar_detector::{Detector, Mpm, WINDOW_LEN};
use std::f64::consts::TAU;

fn sine(frequency: f64, amplitude: f64, sample_rate: f64) -> Vec<f32> {
    (0..WINDOW_LEN)
        .map(|n| (amplitude * (TAU * frequency * n as f64 / sample_rate).sin()) as f32)
        .collect()
}

fn cents(a: f64, b: f64) -> f64 {
    1200.0 * (a / b).log2()
}

#[test]
fn finds_a4_in_a_sine() {
    let detection = Mpm::new().detect(&sine(440.0, 0.5, 48_000.0), 48_000.0);
    let frequency = detection.frequency.expect("a frequency");
    assert!(cents(frequency, 440.0).abs() < 1.0, "{frequency} Hz");
    assert!(
        detection.clarity > 0.95 && detection.clarity <= 1.0,
        "{}",
        detection.clarity
    );
}

#[test]
fn finds_c2_and_c6_at_44_1_khz() {
    for frequency in [65.406_39, 1_046.502_3] {
        let detection = Mpm::new().detect(&sine(frequency, 0.5, 44_100.0), 44_100.0);
        let found = detection.frequency.expect("a frequency");
        assert!(cents(found, frequency).abs() < 2.0, "{frequency} → {found}");
    }
}

#[test]
fn picks_the_fundamental_of_a_harmonic_rich_tone_not_an_octave() {
    // A tone whose second harmonic is stronger than its fundamental.
    let rate = 48_000.0;
    let window: Vec<f32> = (0..WINDOW_LEN)
        .map(|n| {
            let t = n as f64 / rate;
            (0.3 * (TAU * 220.0 * t).sin() + 0.6 * (TAU * 440.0 * t).sin()) as f32
        })
        .collect();
    let found = Mpm::new()
        .detect(&window, rate)
        .frequency
        .expect("a frequency");
    assert!(cents(found, 220.0).abs() < 2.0, "{found}");
}

#[test]
fn applies_no_gate_a_very_quiet_tone_is_still_reported() {
    let detection = Mpm::new().detect(&sine(440.0, 3e-5, 48_000.0), 48_000.0); // about −93 dBFS
    let frequency = detection.frequency.expect("a frequency, however quiet");
    assert!(cents(frequency, 440.0).abs() < 1.0);
    assert!(detection.clarity > 0.95);
}

#[test]
fn silence_has_no_frequency_and_zero_clarity() {
    let detection = Mpm::new().detect(&[0.0; WINDOW_LEN], 48_000.0);
    assert_eq!(detection.frequency, None);
    assert_eq!(detection.clarity, 0.0);
}

#[test]
fn a_constant_offset_has_no_frequency() {
    let detection = Mpm::new().detect(&[0.25; WINDOW_LEN], 48_000.0);
    assert_eq!(detection.frequency, None);
    assert!((0.0..=1.0).contains(&detection.clarity));
}

#[test]
fn one_detector_handles_both_sample_rates_and_repeated_windows() {
    let mut mpm = Mpm::new();
    for rate in [48_000.0, 44_100.0, 48_000.0] {
        let found = mpm.detect(&sine(330.0, 0.5, rate), rate).frequency.unwrap();
        assert!(cents(found, 330.0).abs() < 1.0);
    }
}
