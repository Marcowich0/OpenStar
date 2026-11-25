//! The OpenStar Mic bridge (v1 spec #51): reads every channel of an audio
//! interface as one stream and joins the Stage through the server, which
//! approves it once and knows it by its approval token from then on.
//!
//! This build is headless and reads a WAV file in place of an interface
//! (`--wav <file>`): each channel of the file is one hardware channel, and
//! the file name is the interface's device name. It sends meter levels
//! ([`levels`]); capture (#205), Pitch readings (#153), the window (#204)
//! and updates (#209) come later.

pub mod cli;
pub mod client;
pub mod config;
pub mod levels;
pub mod wav;

/// The build identifier, worked out exactly as the server's (`X.Y.Z`,
/// `edge-<sha>` or `dev`).
pub const BUILD_ID: &str = env!("OPENSTAR_BUILD_ID");
