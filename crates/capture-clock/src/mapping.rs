//! The frame-to-clock mapping: audio frames onto the device clock.

/// Spreads kept for the lower envelope: the last 100 readings, about 1 s.
pub const SPREAD_COUNT: usize = 100;

/// Half the detector window (2048 frames): a reading is stamped at its
/// window's centre, this many frames before its `endFrame`.
pub const HALF_WINDOW_FRAMES: f64 = 1024.0;

/// Maps a reading's `endFrame` onto the device clock.
///
/// For each reading, frame time *F* = `end_frame / sample_rate` (ms) and
/// spread *k* = *A* − *F*, where *A* is when its message was handled on the
/// device clock. *K* is the minimum of the last [`SPREAD_COUNT`] spreads (the
/// reading that waited least defines the mapping), and the capture time is
/// *F* + *K* − half a window.
///
/// A new `AudioContext` or capture stream restarts the frame counter: call
/// [`reset`](Self::reset). A frame counter that goes backwards or a new sample
/// rate also resets it, since the old spreads cannot belong to that stream.
#[derive(Debug, Clone)]
pub struct FrameMapping {
    spreads: [f64; SPREAD_COUNT],
    len: usize,
    next: usize,
    last_end_frame: f64,
    sample_rate: f64,
}

impl Default for FrameMapping {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameMapping {
    pub fn new() -> Self {
        Self {
            spreads: [0.0; SPREAD_COUNT],
            len: 0,
            next: 0,
            last_end_frame: f64::NEG_INFINITY,
            sample_rate: f64::NAN,
        }
    }

    /// Discards every stored spread (a new stream).
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    /// The capture time (window centre, ms on the device clock) of a reading
    /// ending at `end_frame`, handled at `handled_ms`. `None` for an input
    /// that is not a finite time or a positive sample rate; it is not stored.
    pub fn stamp(&mut self, end_frame: f64, sample_rate: f64, handled_ms: f64) -> Option<f64> {
        if !(end_frame.is_finite() && handled_ms.is_finite() && sample_rate.is_finite())
            || sample_rate <= 0.0
        {
            return None;
        }
        if sample_rate != self.sample_rate || end_frame < self.last_end_frame {
            self.reset();
            self.sample_rate = sample_rate;
        }
        self.last_end_frame = end_frame;
        let frame_ms = end_frame / sample_rate * 1000.0;
        self.spreads[self.next] = handled_ms - frame_ms;
        self.next = (self.next + 1) % SPREAD_COUNT;
        self.len = (self.len + 1).min(SPREAD_COUNT);
        let envelope = self.spreads[..self.len]
            .iter()
            .copied()
            .fold(f64::INFINITY, f64::min);
        Some(frame_ms + envelope - HALF_WINDOW_FRAMES / sample_rate * 1000.0)
    }
}
