//! The server's clock. Production reads the system clock; integration tests
//! hand the server a [`ManualClock`] and move it forward, so 30-minute (and
//! 15-minute) waits run instantly.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime};

/// The time source every timed rule in the server reads. Cheap to clone.
#[derive(Clone, Default)]
pub struct Clock {
    manual: Option<Arc<Mutex<SystemTime>>>,
}

impl Clock {
    /// The system clock.
    pub fn system() -> Self {
        Self::default()
    }

    /// The current wall-clock time.
    pub fn now(&self) -> SystemTime {
        match &self.manual {
            None => SystemTime::now(),
            Some(now) => *now.lock().unwrap_or_else(PoisonError::into_inner),
        }
    }

    /// The current time in whole milliseconds since the Unix epoch, as stored
    /// in SQLite.
    pub fn now_millis(&self) -> i64 {
        let since_epoch = self
            .now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default();
        i64::try_from(since_epoch.as_millis()).unwrap_or(i64::MAX)
    }
}

/// A clock that stands still until the test moves it. Clones share one time,
/// so a server restarted with the same `ManualClock` sees time carry on.
#[derive(Clone)]
pub struct ManualClock {
    now: Arc<Mutex<SystemTime>>,
}

impl ManualClock {
    /// A clock that starts at the current system time.
    pub fn new() -> Self {
        Self {
            now: Arc::new(Mutex::new(SystemTime::now())),
        }
    }

    /// Moves the time forward by `by`.
    pub fn advance(&self, by: Duration) {
        let mut now = self.now.lock().unwrap_or_else(PoisonError::into_inner);
        *now += by;
    }

    /// The [`Clock`] to hand the server (`Server::with_clock`).
    pub fn clock(&self) -> Clock {
        Clock {
            manual: Some(Arc::clone(&self.now)),
        }
    }
}

impl Default for ManualClock {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_manual_clock_moves_only_when_advanced() {
        let manual = ManualClock::new();
        let clock = manual.clock();
        let start = clock.now_millis();
        assert_eq!(clock.now_millis(), start);
        manual.advance(Duration::from_secs(90));
        assert_eq!(clock.now_millis(), start + 90_000);
    }
}
