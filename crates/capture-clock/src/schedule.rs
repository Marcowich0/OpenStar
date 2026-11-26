//! When the next clock ping is due.

/// The ping interval while pinging fast.
pub const FAST_PING_INTERVAL_MS: f64 = 200.0;
/// How long pinging stays fast after capture starts or the Stage changes.
pub const FAST_PINGS_FOR_MS: f64 = 5000.0;
/// The ping interval after that, for as long as capture lasts.
pub const SLOW_PING_INTERVAL_MS: f64 = 1000.0;

/// Pings only while capturing: the first at once when capture starts, then
/// every [`FAST_PING_INTERVAL_MS`] until [`FAST_PINGS_FOR_MS`] have passed,
/// then every [`SLOW_PING_INTERVAL_MS`]. [`ping_fast`](Self::ping_fast)
/// starts the fast phase again. A ping's interval to the next is chosen by
/// the time it was sent: a ping sent inside the fast phase is followed
/// 200 ms later.
#[derive(Debug, Clone, Default)]
pub struct PingSchedule {
    capturing: bool,
    fast_since: f64,
    last_ping: Option<f64>,
}

impl PingSchedule {
    pub fn new() -> Self {
        Self::default()
    }

    /// Capture started at `now_ms`: ping at once, then fast.
    pub fn start(&mut self, now_ms: f64) {
        *self = Self {
            capturing: true,
            fast_since: now_ms,
            last_ping: None,
        };
    }

    /// Capture stopped: no more pings until it starts again.
    pub fn stop(&mut self) {
        self.capturing = false;
    }

    /// Ping fast again from `now_ms` (a new epoch, a reconnect).
    pub fn ping_fast(&mut self, now_ms: f64) {
        self.fast_since = now_ms;
    }

    /// When the next ping is due; `None` while not capturing.
    pub fn next_ping_at(&self) -> Option<f64> {
        if !self.capturing {
            return None;
        }
        Some(match self.last_ping {
            None => self.fast_since,
            Some(last) if last < self.fast_since + FAST_PINGS_FOR_MS => {
                // A ping sent before a fast restart is followed fast too.
                last + FAST_PING_INTERVAL_MS
            }
            Some(last) => last + SLOW_PING_INTERVAL_MS,
        })
    }

    /// `Some(now_ms)` when a ping is due at `now_ms`, which is then counted as
    /// sent (its `t0`); `None` otherwise.
    pub fn poll(&mut self, now_ms: f64) -> Option<f64> {
        let due = self.next_ping_at()?;
        if now_ms < due {
            return None;
        }
        self.last_ping = Some(now_ms);
        Some(now_ms)
    }
}
