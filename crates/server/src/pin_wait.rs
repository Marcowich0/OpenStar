//! The one shared wrong-guess wait every Admin PIN check goes through.
//!
//! Wrong guesses are counted once for the whole server, never per browser or
//! per address. The first [`FREE_GUESSES`] wrong guesses in a row are free;
//! each further one starts a wait of 1, 2, 4 and 8 minutes, then
//! [`LONGEST_WAIT`] for every one after that. While a wait runs no PIN is
//! checked, not even the correct one, and the refused attempt does not count.
//! A correct PIN resets the count. The count and the end of the wait live in
//! memory only, so a restart clears them.
//!
//! The Unlock (`POST /api/unlock`) checks its PIN here; becoming the Stage
//! (#186) is to check its PIN through the same [`AdminPin::check`], so both
//! share one count.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;

use crate::clock::Clock;
use crate::unlock::pin_fingerprint;

/// Wrong guesses in a row that start no wait.
pub const FREE_GUESSES: u32 = 5;

/// The first wait, started by the first wrong guess after the free ones.
pub const FIRST_WAIT: Duration = Duration::from_secs(60);

/// The cap on a wait.
pub const LONGEST_WAIT: Duration = Duration::from_secs(15 * 60);

/// How long the wait started by the `wrong`-th wrong guess in a row lasts.
pub fn wait_after(wrong: u32) -> Duration {
    match wrong.checked_sub(FREE_GUESSES + 1) {
        None => Duration::ZERO,
        Some(doublings) => FIRST_WAIT
            .checked_mul(2_u32.checked_pow(doublings).unwrap_or(u32::MAX))
            .map_or(LONGEST_WAIT, |wait| wait.min(LONGEST_WAIT)),
    }
}

/// The answer to one PIN attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinCheck {
    /// The PIN is the running Admin PIN; the count starts again.
    Correct,
    /// The PIN is wrong; it was counted.
    Wrong,
    /// A wait runs, so the PIN was not checked. Whole seconds left, rounded
    /// up, so never 0.
    Wait { seconds_left: u32 },
}

/// Where a PIN attempt came from, for the log only: the address the reverse
/// proxy forwards and the socket peer. Never used to count.
#[derive(Debug, Clone, Default)]
pub struct ClientAddress {
    /// The `X-Forwarded-For` header, as sent.
    pub forwarded_for: Option<String>,
    /// The TCP peer (the reverse proxy, when there is one).
    pub peer: Option<SocketAddr>,
}

impl<S: Send + Sync> FromRequestParts<S> for ClientAddress {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(Self {
            forwarded_for: parts
                .headers
                .get("x-forwarded-for")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            peer: parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|ConnectInfo(addr)| *addr),
        })
    }
}

#[derive(Default)]
struct Guesses {
    /// Wrong guesses in a row since the last correct PIN (or the start).
    wrong: u32,
    /// When the running wait ends, in milliseconds since the Unix epoch.
    wait_ends_ms: Option<i64>,
}

/// The running Admin PIN and the shared wrong-guess count. Cheap to clone;
/// clones share one count.
#[derive(Clone)]
pub struct AdminPin {
    fingerprint: Arc<[u8]>,
    guesses: Arc<Mutex<Guesses>>,
}

impl AdminPin {
    /// The Admin PIN the server runs with, with no wrong guesses yet.
    pub fn new(pin: &str) -> Self {
        Self {
            fingerprint: pin_fingerprint(pin).into(),
            guesses: Arc::default(),
        }
    }

    /// The fingerprint of the running Admin PIN.
    pub fn fingerprint(&self) -> &[u8] {
        &self.fingerprint
    }

    /// One PIN attempt from `client`, at the time of `clock`. Every PIN
    /// check in the server goes through here. Logs each wrong guess with the
    /// client's addresses, never the PIN.
    pub fn check(&self, pin: &str, clock: &Clock, client: &ClientAddress) -> PinCheck {
        let now = clock.now_millis();
        // Held only for this synchronous update, never across an await.
        let mut guesses = self.guesses.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(ends) = guesses.wait_ends_ms {
            if now < ends {
                let left_ms = ends.saturating_sub(now);
                let seconds_left = u32::try_from(left_ms.saturating_add(999) / 1000)
                    .unwrap_or(u32::MAX)
                    .max(1);
                return PinCheck::Wait { seconds_left };
            }
            guesses.wait_ends_ms = None;
        }
        if *pin_fingerprint(pin) == *self.fingerprint {
            *guesses = Guesses::default();
            return PinCheck::Correct;
        }
        guesses.wrong = guesses.wrong.saturating_add(1);
        let wait = wait_after(guesses.wrong);
        if !wait.is_zero() {
            let wait_ms = i64::try_from(wait.as_millis()).unwrap_or(i64::MAX);
            guesses.wait_ends_ms = Some(now.saturating_add(wait_ms));
        }
        tracing::warn!(
            forwarded_for = client.forwarded_for.as_deref().unwrap_or("-"),
            peer = %client.peer.map_or_else(|| "-".to_owned(), |peer| peer.to_string()),
            wrong_in_a_row = guesses.wrong,
            wait_seconds = wait.as_secs(),
            "a wrong Admin PIN was entered"
        );
        PinCheck::Wrong
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_waits_are_free_then_1_2_4_8_and_15_minutes() {
        let minutes: Vec<u64> = (1..=14).map(|n| wait_after(n).as_secs() / 60).collect();
        assert_eq!(minutes, [0, 0, 0, 0, 0, 1, 2, 4, 8, 15, 15, 15, 15, 15]);
        assert_eq!(wait_after(u32::MAX), LONGEST_WAIT);
    }
}
