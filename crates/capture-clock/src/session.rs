//! The sender session: the mapping, the estimator and the ping schedule of one
//! capturing Mic.

use crate::{ClockSync, FrameMapping, PingSchedule, Pong};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// A Phone or a Mic bridge: synced to the Stage by pings.
    Remote,
    /// The Stage browser's own Local mics: already on the Stage's clock.
    Local,
}

/// One capturing Mic's way from a reading's `endFrame` to its capture time on
/// the Stage's clock.
///
/// A [`remote`](Self::remote) session stamps a reading at its device capture
/// time plus the clock offset, and only once an offset exists for the current
/// epoch: a reading handled before that is dropped (`None`), never held back.
/// A [`local`](Self::local) session has a fixed offset of 0 and never pings.
#[derive(Debug, Clone)]
pub struct SenderSession {
    kind: Kind,
    mapping: FrameMapping,
    sync: ClockSync,
    schedule: PingSchedule,
}

impl SenderSession {
    pub fn remote() -> Self {
        Self::new(Kind::Remote)
    }

    pub fn local() -> Self {
        Self::new(Kind::Local)
    }

    fn new(kind: Kind) -> Self {
        Self {
            kind,
            mapping: FrameMapping::new(),
            sync: ClockSync::new(),
            schedule: PingSchedule::new(),
        }
    }

    /// Capture started (or started again on a new `AudioContext` or stream)
    /// at `now_ms`: the frame mapping starts afresh and pinging starts fast.
    /// The clock offset is kept: the Stage's clock has not changed.
    pub fn start_capture(&mut self, now_ms: f64) {
        self.mapping.reset();
        if self.kind == Kind::Remote {
            self.schedule.start(now_ms);
        }
    }

    /// Capture stopped: no more pings.
    pub fn stop_capture(&mut self) {
        self.schedule.stop();
    }

    /// The connection to the Stage was made again at `now_ms` (a reconnect):
    /// every sample is discarded, readings are dropped until a new offset
    /// exists, and pinging is fast again.
    pub fn restart_sync(&mut self, now_ms: f64) {
        if self.kind == Kind::Remote {
            self.sync.clear();
            self.schedule.ping_fast(now_ms);
        }
    }

    /// `Some(t0)` when a ping is due at `now_ms` (send `ClockPing { t0 }`);
    /// never for a local session.
    pub fn poll_ping(&mut self, now_ms: f64) -> Option<f64> {
        self.schedule.poll(now_ms)
    }

    /// When the next ping is due, for a timer; `None` while none will be.
    pub fn next_ping_at(&self) -> Option<f64> {
        self.schedule.next_ping_at()
    }

    /// A pong arrived (`t1` is when it was handled). A new epoch discards
    /// every sample and pings fast again from `t1`. A local session ignores it.
    pub fn receive_pong(&mut self, pong: Pong) {
        if self.kind == Kind::Remote && self.sync.add(pong) {
            self.schedule.ping_fast(pong.t1);
        }
    }

    /// Stage clock − device clock (ms): 0 for a local session, `None` for a
    /// remote one before its first sample of the current epoch.
    pub fn offset_ms(&self) -> Option<f64> {
        match self.kind {
            Kind::Local => Some(0.0),
            Kind::Remote => self.sync.offset_ms(),
        }
    }

    /// The capture time on the Stage's clock (ms) of a reading ending at
    /// `end_frame`, handled at `handled_ms` on the device clock; `None` when
    /// it is dropped. The mapping learns from every reading, dropped or not.
    pub fn stamp(&mut self, end_frame: f64, sample_rate: f64, handled_ms: f64) -> Option<f64> {
        let device = self.mapping.stamp(end_frame, sample_rate, handled_ms)?;
        Some(device + self.offset_ms()?)
    }
}
