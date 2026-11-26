//! The capture clock ([`openstar_capture_clock`]) for the main thread: the
//! frame-to-clock mapping and the clock sync of each capturing Mic. The
//! TypeScript wrapper is `web/src/pitch/clock/senderSession.ts`.
//!
//! One instance holds any number of sender sessions, named by the id
//! [`openstar_clock_new`] returns (never 0). An unknown id does nothing and
//! reads as "none". Every time is in ms on the page's `performance.now()`;
//! "none" is NaN.

use openstar_capture_clock::{Pong, SenderSession};
use std::cell::RefCell;

thread_local! {
    static SESSIONS: RefCell<Vec<Option<SenderSession>>> = const { RefCell::new(Vec::new()) };
}

fn with_session<R>(id: u32, f: impl FnOnce(&mut SenderSession) -> R) -> Option<R> {
    let index = (id as usize).checked_sub(1)?;
    SESSIONS.with(|sessions| {
        sessions
            .borrow_mut()
            .get_mut(index)
            .and_then(Option::as_mut)
            .map(f)
    })
}

fn or_nan(value: Option<Option<f64>>) -> f64 {
    value.flatten().unwrap_or(f64::NAN)
}

/// Makes a session: `local` = 1 for the Stage browser's own Local mics
/// (offset 0, no pings), 0 for a Phone (synced by pings). Returns its id.
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_clock_new(local: u32) -> u32 {
    let session = if local == 0 {
        SenderSession::remote()
    } else {
        SenderSession::local()
    };
    SESSIONS.with(|sessions| {
        let mut sessions = sessions.borrow_mut();
        let index = match sessions.iter().position(Option::is_none) {
            Some(free) => {
                sessions[free] = Some(session);
                free
            }
            None => {
                sessions.push(Some(session));
                sessions.len() - 1
            }
        };
        index as u32 + 1
    })
}

/// Ends a session; its id may be given out again.
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_clock_free(id: u32) {
    if let Some(index) = (id as usize).checked_sub(1) {
        SESSIONS.with(|sessions| {
            if let Some(slot) = sessions.borrow_mut().get_mut(index) {
                *slot = None;
            }
        });
    }
}

/// Capture started (again) at `now_ms`: [`SenderSession::start_capture`].
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_clock_start_capture(id: u32, now_ms: f64) {
    with_session(id, |s| s.start_capture(now_ms));
}

/// Capture stopped: [`SenderSession::stop_capture`].
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_clock_stop_capture(id: u32) {
    with_session(id, SenderSession::stop_capture);
}

/// The connection was made again: [`SenderSession::restart_sync`].
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_clock_restart_sync(id: u32, now_ms: f64) {
    with_session(id, |s| s.restart_sync(now_ms));
}

/// The `t0` of a ping due at `now_ms` (counted as sent), NaN when none is.
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_clock_poll_ping(id: u32, now_ms: f64) -> f64 {
    or_nan(with_session(id, |s| s.poll_ping(now_ms)))
}

/// When the next ping is due, NaN when none will be.
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_clock_next_ping_at(id: u32) -> f64 {
    or_nan(with_session(id, |s| s.next_ping_at()))
}

/// A pong handled at `t1`: [`SenderSession::receive_pong`].
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_clock_receive_pong(id: u32, t0: f64, t1: f64, ts: f64, epoch: f64) {
    with_session(id, |s| s.receive_pong(Pong { t0, t1, ts, epoch }));
}

/// Stage clock − page clock, NaN before an offset exists.
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_clock_offset(id: u32) -> f64 {
    or_nan(with_session(id, |s| s.offset_ms()))
}

/// A reading's capture time on the Stage's clock, NaN when it is dropped:
/// [`SenderSession::stamp`].
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_clock_stamp(
    id: u32,
    end_frame: f64,
    sample_rate: f64,
    handled_ms: f64,
) -> f64 {
    or_nan(with_session(id, |s| {
        s.stamp(end_frame, sample_rate, handled_ms)
    }))
}
