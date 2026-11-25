//! OpenStar's one live pitch detector and the step that turns a Mic's audio
//! into Pitch readings.
//!
//! - [`Detector`] is the swappable interface: one window of samples and its
//!   sample rate in, a frequency (or none) and a clarity out.
//! - [`Mpm`] is the McLeod Pitch Method behind it.
//! - [`ReadingMaker`] takes mono audio blocks of any size and makes a
//!   [`PitchReading`] every 10 ms of new audio, from the newest
//!   [`WINDOW_LEN`] samples. The window, the cadence, the MIDI conversion and
//!   the loudness live here, outside the detector.
//!
//! The crate is pure safe Rust with no audio API, so it runs natively in the
//! Mic bridge and as WASM in the browser's `AudioWorklet`.

mod detector;
mod fft;
mod mpm;
mod reading;

pub use detector::{Detection, Detector};
pub use mpm::Mpm;
pub use reading::{
    PitchReading, ReadingMaker, SILENCE_DBFS, WINDOW_LEN, frequency_to_midi, hop_len, loudness_dbfs,
};
