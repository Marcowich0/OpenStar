//! The clock sync estimator: ping samples → the offset to the Stage's clock.

/// Samples kept: the last 30 of the current epoch.
pub const SAMPLE_COUNT: usize = 30;

/// One answered ping: sent at `t0` and answered at `t1` on the sender's
/// clock, stamped `ts` by the Stage on its clock, whose epoch (the Stage
/// page's `performance.timeOrigin`) is `epoch`. All in ms.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pong {
    pub t0: f64,
    pub t1: f64,
    pub ts: f64,
    pub epoch: f64,
}

#[derive(Debug, Clone, Copy)]
struct Sample {
    round_trip: f64,
    offset: f64,
}

/// Keeps the last [`SAMPLE_COUNT`] samples of one epoch. Per sample, round
/// trip = `t1 − t0` and offset = `ts − (t0 + t1) / 2`; the estimate is the
/// offset of the sample with the lowest round trip (the newest of equals). A
/// sample with another epoch discards every earlier one, unless it answers a
/// ping sent before the one that started the current epoch: that is a stale
/// pong from a Stage page that has gone, and it is ignored.
#[derive(Debug, Clone)]
pub struct ClockSync {
    samples: [Sample; SAMPLE_COUNT],
    len: usize,
    next: usize,
    epoch: Option<f64>,
    /// The `t0` of the ping whose pong started the current epoch.
    epoch_t0: f64,
}

impl Default for ClockSync {
    fn default() -> Self {
        Self::new()
    }
}

impl ClockSync {
    pub fn new() -> Self {
        Self {
            samples: [Sample {
                round_trip: 0.0,
                offset: 0.0,
            }; SAMPLE_COUNT],
            len: 0,
            next: 0,
            epoch: None,
            epoch_t0: f64::NEG_INFINITY,
        }
    }

    /// Discards every sample and the epoch (a reconnect).
    pub fn clear(&mut self) {
        *self = Self::new();
    }

    /// Adds a sample. Returns `true` when it started a new epoch (the Stage
    /// page reloaded or moved), so the caller pings fast again. A pong with a
    /// time that is not finite or a negative round trip is ignored, and so is
    /// a stale pong of another epoch.
    pub fn add(&mut self, pong: Pong) -> bool {
        let Pong { t0, t1, ts, epoch } = pong;
        if ![t0, t1, ts, epoch].iter().all(|v| v.is_finite()) || t1 < t0 {
            return false;
        }
        let new_epoch = self.epoch != Some(epoch);
        if new_epoch {
            if t0 < self.epoch_t0 {
                return false;
            }
            self.clear();
            self.epoch = Some(epoch);
            self.epoch_t0 = t0;
        }
        self.samples[self.next] = Sample {
            round_trip: t1 - t0,
            offset: ts - (t0 + t1) / 2.0,
        };
        self.next = (self.next + 1) % SAMPLE_COUNT;
        self.len = (self.len + 1).min(SAMPLE_COUNT);
        new_epoch
    }

    /// The Stage's epoch the samples belong to.
    pub fn epoch(&self) -> Option<f64> {
        self.epoch
    }

    /// Stage clock − device clock, in ms; `None` before the first sample.
    pub fn offset_ms(&self) -> Option<f64> {
        // Oldest to newest, so `<=` keeps the newest of equal round trips.
        let mut best: Option<Sample> = None;
        for i in 0..self.len {
            let sample = self.samples[(self.next + SAMPLE_COUNT - self.len + i) % SAMPLE_COUNT];
            if best.is_none_or(|b| sample.round_trip <= b.round_trip) {
                best = Some(sample);
            }
        }
        best.map(|b| b.offset)
    }
}
