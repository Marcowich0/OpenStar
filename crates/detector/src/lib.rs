//! OpenStar's one live pitch detector and the step that turns a Mic's audio
//! into Pitch readings, and the separate detector of a Song's Pitch track.
//!
//! - [`Detector`] is the swappable interface: one window of samples and its
//!   sample rate in, a frequency (or none) and a clarity out.
//! - [`Mpm`] is the McLeod Pitch Method behind it.
//! - [`ReadingMaker`] takes mono audio blocks of any size and makes a
//!   [`PitchReading`] every 10 ms of new audio, from the newest
//!   [`WINDOW_LEN`] samples. The window, the cadence, the MIDI conversion and
//!   the loudness live here, outside the detector.
//! - [`TrackDetector`] is the swappable, versioned interface for a Song's
//!   Pitch track (one frame every 10 ms of 16 kHz audio), and [`Yin`] is the
//!   detector behind it. It is YIN, not MPM, on purpose: see [`pitch_track`].
//!
//! The crate is pure safe Rust with no audio API, so it runs natively in the
//! Mic bridge and as WASM in the browser's `AudioWorklet`.

mod detector;
mod fft;
mod mpm;
pub mod pitch_track;
mod reading;

pub use detector::{Detection, Detector};
pub use mpm::Mpm;
pub use pitch_track::{
    FRAME_SECONDS, PitchTrack, TRACK_HOP_LEN, TRACK_SAMPLE_RATE, TRACK_WINDOW_LEN, TrackDetector,
    Yin, track_lag_range,
};
pub use reading::{
    PitchReading, ReadingMaker, SILENCE_DBFS, WINDOW_LEN, frequency_to_midi, hop_len, loudness_dbfs,
};
