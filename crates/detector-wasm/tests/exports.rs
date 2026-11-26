//! The C ABI, called natively: it reports exactly what a `ReadingMaker` over
//! `Mpm` reports for the same blocks. (The WASM build of the same exports runs
//! in Vitest, `web/src/pitch/worklet/`.)

use openstar_detector::{Mpm, PitchReading, ReadingMaker};
use openstar_detector_wasm::*;

fn tone(len: usize, hz: f64, rate: f64) -> Vec<f32> {
    (0..len)
        .map(|n| (0.3 * (std::f64::consts::TAU * hz * n as f64 / rate).sin()) as f32)
        .collect()
}

fn via_exports(samples: &[f32], rate: f64) -> Vec<PitchReading> {
    let input = openstar_detector_start(rate);
    assert!(!input.is_null());
    let mut readings = Vec::new();
    for block in samples.chunks(openstar_detector_block_capacity() as usize) {
        write_input(block);
        if openstar_detector_push(block.len() as u32) == 1 {
            let pitch = openstar_detector_pitch();
            readings.push(PitchReading {
                pitch: (!pitch.is_nan()).then_some(pitch),
                clarity: openstar_detector_clarity(),
                loudness_dbfs: openstar_detector_loudness(),
                end_frame: openstar_detector_end_frame() as u64,
            });
        }
    }
    readings
}

fn native(samples: &[f32], rate: f64) -> Vec<PitchReading> {
    let mut maker = ReadingMaker::new(Mpm::new(), rate);
    samples
        .chunks(128)
        .filter_map(|b| maker.push_block(b))
        .collect()
}

#[test]
fn the_exports_report_what_the_reading_maker_reports() {
    for rate in [44_100.0, 48_000.0] {
        let mut samples = tone(24_000, 220.0, rate);
        samples.extend(vec![0.0; 8_000]);
        let readings = via_exports(&samples, rate);
        assert_eq!(readings, native(&samples, rate));
        assert!(readings.iter().any(|r| r.pitch.is_some()));
        assert!(readings.iter().any(|r| r.loudness_dbfs == -120.0));
    }
}

#[test]
fn a_restart_counts_frames_from_zero_again() {
    let samples = tone(4_096, 440.0, 48_000.0);
    let first = via_exports(&samples, 48_000.0);
    let second = via_exports(&samples, 48_000.0);
    assert_eq!(first, second);
    assert_eq!(first[0].end_frame, 2048);
}

#[test]
fn a_block_over_the_capacity_is_cut_to_it() {
    openstar_detector_start(48_000.0);
    for _ in 0..15 {
        assert_eq!(openstar_detector_push(10_000), 0);
    }
    // 16 × 128 = 2048 frames: the window is full.
    assert_eq!(openstar_detector_push(10_000), 1);
    assert_eq!(openstar_detector_end_frame(), 2048.0);
}
