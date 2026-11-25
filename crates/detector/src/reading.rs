use crate::detector::Detector;

/// Samples in every detector window: the newest 2048 mono samples.
pub const WINDOW_LEN: usize = 2048;

/// The loudness reported for digital silence, and the floor for anything quieter.
pub const SILENCE_DBFS: f64 = -120.0;

/// The cadence: a reading is due once this many new samples (10 ms) have arrived.
pub fn hop_len(sample_rate: f64) -> u64 {
    (sample_rate * 0.010).round() as u64
}

/// A fractional MIDI note number, `69 + 12 × log2(f / 440 Hz)` (A4 = 69).
pub fn frequency_to_midi(frequency: f64) -> f64 {
    69.0 + 12.0 * (frequency / 440.0).log2()
}

/// The RMS of `samples` in dBFS (a full-scale square wave is 0 dBFS), floored
/// at [`SILENCE_DBFS`].
pub fn loudness_dbfs(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return SILENCE_DBFS;
    }
    let sum_sq: f64 = samples.iter().map(|&s| f64::from(s) * f64::from(s)).sum();
    let mean_sq = sum_sq / samples.len() as f64;
    if mean_sq <= 0.0 {
        return SILENCE_DBFS;
    }
    (10.0 * mean_sq.log10()).max(SILENCE_DBFS)
}

/// One measurement of what a Mic heard over one window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PitchReading {
    /// Fractional MIDI note number; `None` when the detector found no frequency.
    pub pitch: Option<f64>,
    /// The detector's clarity, 0 to 1.
    pub clarity: f64,
    /// The RMS of the same window in dBFS; digital silence is −120.
    pub loudness_dbfs: f64,
    /// The frame index just after the newest sample in the window, counted
    /// from the first sample fed to the [`ReadingMaker`].
    pub end_frame: u64,
}

impl PitchReading {
    /// The frame at the centre of the reading's window, where it is stamped.
    pub fn window_centre_frame(&self) -> u64 {
        self.end_frame - (WINDOW_LEN as u64 / 2)
    }
}

/// Turns a stream of mono audio blocks into Pitch readings.
///
/// It keeps the newest [`WINDOW_LEN`] samples. At the end of each block it
/// makes a reading if the window has filled and at least [`hop_len`] new
/// samples arrived since the previous reading, so it makes at most one reading
/// per block. It never allocates after [`ReadingMaker::new`].
pub struct ReadingMaker<D> {
    detector: D,
    sample_rate: f64,
    hop: u64,
    /// Ring buffer of the newest samples; `next` is where the next one goes.
    ring: Vec<f32>,
    next: usize,
    /// The window handed to the detector, oldest sample first.
    window: Vec<f32>,
    frames: u64,
    last_reading_end: Option<u64>,
}

impl<D: Detector> ReadingMaker<D> {
    pub fn new(detector: D, sample_rate: f64) -> Self {
        Self {
            detector,
            sample_rate,
            hop: hop_len(sample_rate).max(1),
            ring: vec![0.0; WINDOW_LEN],
            next: 0,
            window: vec![0.0; WINDOW_LEN],
            frames: 0,
            last_reading_end: None,
        }
    }

    /// Feeds one block of mono samples; returns the reading made at its end, if one was due.
    pub fn push_block(&mut self, block: &[f32]) -> Option<PitchReading> {
        // Only the newest WINDOW_LEN samples of a big block can matter.
        let keep = &block[block.len().saturating_sub(WINDOW_LEN)..];
        for &sample in keep {
            self.ring[self.next] = sample;
            self.next = (self.next + 1) % WINDOW_LEN;
        }
        self.frames += block.len() as u64;

        if self.frames < WINDOW_LEN as u64 {
            return None;
        }
        if let Some(last) = self.last_reading_end
            && self.frames - last < self.hop
        {
            return None;
        }
        self.last_reading_end = Some(self.frames);
        Some(self.make_reading())
    }

    fn make_reading(&mut self) -> PitchReading {
        let (newer, older) = self.ring.split_at(self.next);
        self.window[..older.len()].copy_from_slice(older);
        self.window[older.len()..].copy_from_slice(newer);

        let detection = self.detector.detect(&self.window, self.sample_rate);
        PitchReading {
            pitch: detection.frequency.map(frequency_to_midi),
            clarity: detection.clarity,
            loudness_dbfs: loudness_dbfs(&self.window),
            end_frame: self.frames,
        }
    }

    /// The detector behind this reading maker.
    pub fn detector(&self) -> &D {
        &self.detector
    }

    /// The capture's sample rate, as given to [`ReadingMaker::new`].
    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }
}
