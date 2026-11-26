//! The OpenStar Mic bridge (v1 spec #51): reads every channel of an audio
//! interface as one stream and joins the Stage through the server, which
//! approves it once and knows it by its approval token from then on.
//!
//! Started without arguments, it opens its [`window`] and connects only
//! while the window is open. With `--wav <file>` it runs headless and reads
//! the WAV file in place of an interface: each channel of the file is one
//! hardware channel, and the file name is the interface's device name. It
//! sends meter levels ([`levels`]), and [`sender`] turns a Local mic's
//! capture into Pitch readings on the Stage's clock. Capture (#205),
//! running the sender on the WAV input (#153) and updates (#209) come later.

pub mod cli;
pub mod client;
pub mod config;
pub mod levels;
pub mod sender;
pub mod wav;
pub mod window;

/// The build identifier, worked out exactly as the server's (`X.Y.Z`,
/// `edge-<sha>` or `dev`).
pub const BUILD_ID: &str = env!("OPENSTAR_BUILD_ID");
