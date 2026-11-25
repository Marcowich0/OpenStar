//! The reading maker: audio blocks of any size in, Pitch readings out at the
//! decided cadence. A stub detector stands in for MPM here, which also shows
//! that nothing about readings depends on which detector sits behind the
//! interface.

use openstar_detector::{Detection, Detector, PitchReading, ReadingMaker, WINDOW_LEN};

/// Reports a fixed frequency and remembers what it was given.
struct StubDetector {
    frequency: Option<f64>,
    windows: Vec<(Vec<f32>, f64)>,
}

impl StubDetector {
    fn new(frequency: Option<f64>) -> Self {
        Self {
            frequency,
            windows: Vec::new(),
        }
    }
}

impl Detector for StubDetector {
    fn detect(&mut self, window: &[f32], sample_rate: f64) -> Detection {
        self.windows.push((window.to_vec(), sample_rate));
        Detection {
            frequency: self.frequency,
            clarity: 0.5,
        }
    }
}

/// Feeds `total` frames of a ramp (sample value = frame index) in blocks of
/// `block` frames and collects every reading.
fn feed(maker: &mut ReadingMaker<StubDetector>, total: usize, block: usize) -> Vec<PitchReading> {
    let samples: Vec<f32> = (0..total).map(|i| i as f32).collect();
    samples
        .chunks(block)
        .filter_map(|b| maker.push_block(b))
        .collect()
}

#[test]
fn window_is_2048_samples() {
    assert_eq!(WINDOW_LEN, 2048);
}

#[test]
fn first_reading_comes_once_the_window_has_filled() {
    let mut maker = ReadingMaker::new(StubDetector::new(Some(440.0)), 48_000.0);
    let readings = feed(&mut maker, 2047, 128);
    assert!(readings.is_empty(), "no reading before 2048 samples");

    let readings = feed(&mut maker, 1, 1);
    assert_eq!(readings.len(), 1);
}

#[test]
fn at_48_khz_with_128_frame_blocks_a_reading_comes_every_512_frames() {
    let mut maker = ReadingMaker::new(StubDetector::new(Some(440.0)), 48_000.0);
    let readings = feed(&mut maker, 48_000, 128);
    let ends: Vec<u64> = readings.iter().map(|r| r.end_frame).collect();
    assert_eq!(ends[0], 2048);
    assert!(ends.windows(2).all(|w| w[1] - w[0] == 512), "{ends:?}");
}

#[test]
fn at_44_1_khz_the_hop_is_441_samples_checked_at_block_ends() {
    let mut maker = ReadingMaker::new(StubDetector::new(Some(440.0)), 44_100.0);
    // 128-frame blocks: 441 new samples need 4 blocks, so 512 frames apart.
    let readings = feed(&mut maker, 10_000, 128);
    assert!(
        readings
            .windows(2)
            .all(|w| w[1].end_frame - w[0].end_frame == 512)
    );

    // 1-frame blocks: exactly one reading every 441 frames.
    let mut maker = ReadingMaker::new(StubDetector::new(Some(440.0)), 44_100.0);
    let readings = feed(&mut maker, 10_000, 1);
    assert_eq!(readings[0].end_frame, 2048);
    assert!(
        readings
            .windows(2)
            .all(|w| w[1].end_frame - w[0].end_frame == 441)
    );
}

#[test]
fn works_with_blocks_larger_than_the_window() {
    // A Mic bridge may deliver big blocks: one reading per block, on its newest 2048 samples.
    let mut maker = ReadingMaker::new(StubDetector::new(Some(440.0)), 48_000.0);
    let readings = feed(&mut maker, 5 * 3000, 3000);
    let ends: Vec<u64> = readings.iter().map(|r| r.end_frame).collect();
    assert_eq!(ends, vec![3000, 6000, 9000, 12000, 15000]);
}

#[test]
fn detector_sees_the_newest_2048_samples_in_order_and_the_sample_rate() {
    let mut maker = ReadingMaker::new(StubDetector::new(Some(440.0)), 44_100.0);
    let readings = feed(&mut maker, 5000, 100);
    let last = readings.last().expect("readings");
    let (window, rate) = maker.detector().windows.last().expect("windows").clone();
    assert_eq!(rate, 44_100.0);
    assert_eq!(window.len(), 2048);
    let end = last.end_frame as usize;
    let expected: Vec<f32> = (end - 2048..end).map(|i| i as f32).collect();
    assert_eq!(window, expected);
}

#[test]
fn end_frame_is_the_frame_just_after_the_newest_sample_so_the_centre_is_1024_before() {
    let mut maker = ReadingMaker::new(StubDetector::new(Some(440.0)), 48_000.0);
    let readings = feed(&mut maker, 4096, 128);
    for reading in &readings {
        let (window, _) = &maker.detector().windows[readings
            .iter()
            .position(|r| r.end_frame == reading.end_frame)
            .unwrap()];
        // The ramp's value is the frame index, so the newest sample is endFrame − 1.
        assert_eq!(*window.last().unwrap(), (reading.end_frame - 1) as f32);
        assert_eq!(reading.window_centre_frame(), reading.end_frame - 1024);
    }
}

#[test]
fn pitch_is_a_fractional_midi_note_number() {
    let cases = [
        (440.0, 69.0),
        (880.0, 81.0),
        (220.0, 57.0),
        (261.625_565, 60.0),
    ];
    for (frequency, midi) in cases {
        let mut maker = ReadingMaker::new(StubDetector::new(Some(frequency)), 48_000.0);
        let reading = feed(&mut maker, 2048, 2048).remove(0);
        let pitch = reading.pitch.expect("pitch");
        assert!(
            (pitch - midi).abs() < 1e-4,
            "{frequency} Hz → {pitch}, expected {midi}"
        );
    }
    let mut maker = ReadingMaker::new(StubDetector::new(Some(466.163_76)), 48_000.0);
    let pitch = feed(&mut maker, 2048, 2048)[0].pitch.unwrap();
    assert!((pitch - 70.0).abs() < 1e-4);
}

#[test]
fn pitch_is_empty_when_the_detector_found_no_frequency() {
    let mut maker = ReadingMaker::new(StubDetector::new(None), 48_000.0);
    let reading = feed(&mut maker, 2048, 128).remove(0);
    assert_eq!(reading.pitch, None);
    assert_eq!(reading.clarity, 0.5, "clarity is passed through");
}

#[test]
fn loudness_is_the_rms_of_the_window_in_dbfs() {
    // A constant 0.5 has RMS 0.5 = −6.02 dBFS; a full-scale square wave 0 dBFS.
    let mut maker = ReadingMaker::new(StubDetector::new(None), 48_000.0);
    let reading = maker.push_block(&[0.5; 2048]).unwrap();
    assert!(
        (reading.loudness_dbfs - (-6.0206)).abs() < 1e-3,
        "{}",
        reading.loudness_dbfs
    );

    let square: Vec<f32> = (0..2048)
        .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
        .collect();
    let mut maker = ReadingMaker::new(StubDetector::new(None), 48_000.0);
    let reading = maker.push_block(&square).unwrap();
    assert!(reading.loudness_dbfs.abs() < 1e-6);
}

#[test]
fn digital_silence_reads_minus_120_dbfs() {
    let mut maker = ReadingMaker::new(StubDetector::new(None), 48_000.0);
    let reading = maker.push_block(&[0.0; 2048]).unwrap();
    assert_eq!(reading.loudness_dbfs, -120.0);

    // Anything quieter than −120 dBFS reads −120 too.
    let mut maker = ReadingMaker::new(StubDetector::new(None), 48_000.0);
    let reading = maker.push_block(&[1e-9; 2048]).unwrap();
    assert_eq!(reading.loudness_dbfs, -120.0);
}
