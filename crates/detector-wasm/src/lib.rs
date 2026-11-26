//! The live pitch detector ([`openstar_detector`]) as a WASM module for the
//! pitch-detection `AudioWorklet` (`web/src/pitch/worklet/`).
//!
//! It exports a plain C ABI and the worklet calls it directly: no JavaScript
//! glue generator. Each WASM instance holds one [`ReadingMaker`] over [`Mpm`],
//! so a worklet processor instantiates the module once per Mic channel.
//!
//! The calls, in order:
//!
//! 1. [`openstar_detector_start`]`(sample_rate)` makes a fresh reading maker
//!    and returns the address of the input block in the module's memory. It
//!    holds [`openstar_detector_block_capacity`] `f32` samples.
//! 2. Per audio block: write up to that many samples at the address, then
//!    [`openstar_detector_push`]`(len)`. It returns 1 when the block ended
//!    with a Pitch reading, 0 otherwise.
//! 3. After a 1, the reading's fields: [`openstar_detector_pitch`] (MIDI, NaN
//!    when unvoiced), [`openstar_detector_clarity`],
//!    [`openstar_detector_loudness`] (dBFS, −120 for digital silence) and
//!    [`openstar_detector_end_frame`] (frames fed since the start, as `f64`).
//!
//! The input block's address never changes after a start, but the memory can
//! grow (the detector allocates its scratch buffers on the first window), so
//! the caller re-reads `memory.buffer` before each write.
//!
//! The same module also carries the capture clock for the main thread (the
//! `openstar_clock_*` exports, [`clock`]): the frame-to-clock mapping and the
//! clock sync, so the browser runs the very code the Mic bridge links.
//!
//! The only `unsafe` here is `#[unsafe(no_mangle)]` on the exports
//! (`tests/unsafe_rule.rs`).

pub mod clock;

pub use clock::*;
use openstar_detector::{Mpm, PitchReading, ReadingMaker};
use std::cell::RefCell;

/// Samples the input block holds: one `AudioWorklet` render quantum.
pub const BLOCK_CAPACITY: usize = 128;

struct State {
    maker: ReadingMaker<Mpm>,
    input: Vec<f32>,
    reading: Option<PitchReading>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> Option<R> {
    STATE.with(|state| state.borrow_mut().as_mut().map(f))
}

/// The fields of the last reading, or `default` when there is none.
fn reading_field(default: f64, f: impl FnOnce(&PitchReading) -> f64) -> f64 {
    with_state(|state| state.reading.as_ref().map(f))
        .flatten()
        .unwrap_or(default)
}

/// Starts (or restarts) the detector at `sample_rate` and returns the address
/// of the input block.
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_detector_start(sample_rate: f64) -> *mut f32 {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        let state = state.insert(State {
            maker: ReadingMaker::new(Mpm::new(), sample_rate),
            input: vec![0.0; BLOCK_CAPACITY],
            reading: None,
        });
        state.input.as_mut_ptr()
    })
}

/// How many samples the input block holds.
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_detector_block_capacity() -> u32 {
    BLOCK_CAPACITY as u32
}

/// Feeds the first `len` samples of the input block (at most the capacity);
/// returns 1 when a reading was made at the block's end. Before a start it
/// does nothing and returns 0.
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_detector_push(len: u32) -> u32 {
    with_state(|state| {
        let len = (len as usize).min(BLOCK_CAPACITY);
        state.reading = state.maker.push_block(&state.input[..len]);
        u32::from(state.reading.is_some())
    })
    .unwrap_or(0)
}

/// The last reading's pitch as a fractional MIDI note, NaN when unvoiced.
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_detector_pitch() -> f64 {
    reading_field(f64::NAN, |r| r.pitch.unwrap_or(f64::NAN))
}

/// The last reading's clarity, 0 to 1.
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_detector_clarity() -> f64 {
    reading_field(f64::NAN, |r| r.clarity)
}

/// The last reading's loudness in dBFS.
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_detector_loudness() -> f64 {
    reading_field(f64::NAN, |r| r.loudness_dbfs)
}

/// The last reading's `endFrame`, counted from the start (exact below 2⁵³).
#[allow(unsafe_code, reason = "a WASM export needs an unmangled name")]
#[unsafe(no_mangle)]
pub extern "C" fn openstar_detector_end_frame() -> f64 {
    reading_field(f64::NAN, |r| r.end_frame as f64)
}

/// Native callers (tests) write the input block through this instead of the
/// raw address. Not exported.
pub fn write_input(samples: &[f32]) {
    with_state(|state| state.input[..samples.len()].copy_from_slice(samples));
}
