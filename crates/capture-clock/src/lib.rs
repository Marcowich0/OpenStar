//! Puts every Pitch reading on the Stage's clock (v1 spec #50, "Timestamping"
//! and "Clock sync with the Stage"). Written once and used by every capturing
//! device: Phones and the Stage browser through `detector-wasm`, the Mic
//! bridge natively.
//!
//! - [`FrameMapping`]: a reading's `endFrame` and the moment its message was
//!   handled on the device clock → its capture time (window centre) on the
//!   device clock, through the lower envelope of the last 100 spreads.
//! - [`ClockSync`]: ping samples → the device-to-Stage clock offset, from the
//!   lowest round trip of the last 30 samples of the current epoch.
//! - [`PingSchedule`]: when the next ping is due (every 200 ms for 5 s after
//!   capture starts or the Stage changes, then every 1 s).
//! - [`SenderSession`]: the three together. A reading gets a capture time on
//!   the Stage's clock only once an offset exists for the current epoch.
//!
//! Everything is pure: every time is an input, in milliseconds on the
//! device's own clock (`performance.now()` in a browser, a monotonic clock in
//! the Mic bridge), and nothing reads a clock or does I/O.

mod mapping;
mod schedule;
mod session;
mod sync;

pub use mapping::{FrameMapping, HALF_WINDOW_FRAMES, SPREAD_COUNT};
pub use schedule::{FAST_PING_INTERVAL_MS, FAST_PINGS_FOR_MS, PingSchedule, SLOW_PING_INTERVAL_MS};
pub use session::SenderSession;
pub use sync::{ClockSync, Pong, SAMPLE_COUNT};
