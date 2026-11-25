//! The shared harness for OpenStar's server integration tests.
//!
//! - [`TestApp`] starts the real axum app in-process on fresh temporary songs
//!   and appdata folders, on a free local port, and talks to it over real HTTP
//!   and a real WebSocket with the protocol crate's types.
//! - [`FakeUsdb`] is a local HTTP server that serves saved USDB pages from
//!   `fixtures/usdb/`, records every request and can be scripted to fail.
//! - [`YtDlpStub`] is a `yt-dlp` script for the front of `PATH`: it records its
//!   arguments, writes tiny generated media and can be scripted to fail or hang.
//! - [`Media`] makes tones, sine melodies, noise, silence, multichannel WAVs and
//!   a tiny video with the real ffmpeg, only into its own temporary folder.
//! - [`fixture_library`] installs `fixtures/library/` with each Song's audio
//!   generated from its own Notes ([`AppFolders::with_fixture_library`]), and
//!   [`fake_mic`] writes the fake microphone WAVs described in `fixtures/mic/`.
//!
//! The fake USDB and the stub also run as standalone processes, and the
//! fixture Library and the fake mic WAVs are written, for `just e2e`: see the
//! `openstar-harness` binary.
//!
//! Nothing here can reach the real USDB: the app under test reads its settings
//! only from the harness's own variables (never the process environment), they
//! hold no real USDB credentials, and they point USDB at the fake or at a closed
//! local port.

mod app;
pub mod fake_mic;
pub mod fixture_library;
mod media;
mod usdb;
mod ytdlp;

pub use app::{AppFolders, TestApp, TestAppBuilder, WsClient};
pub use media::{Media, Signal, placeholder_media};
pub use usdb::{FakeUsdb, RecordedRequest, Scripted};
pub use ytdlp::{YtDlpStub, YtDlpStubBehaviour};

/// The settings variable the USDB client (#47) reads its base URL from. The
/// harness always sets it, so the app under test never talks to the real USDB.
pub const USDB_BASE_URL_VAR: &str = "OPENSTAR_USDB_BASE_URL";

/// The fake USDB credentials the harness hands the app when a [`FakeUsdb`] is
/// attached. No test environment ever holds real ones.
pub const FAKE_USDB_USERNAME: &str = "fake-usdb-user";
/// See [`FAKE_USDB_USERNAME`].
pub const FAKE_USDB_PASSWORD: &str = "fake-usdb-password";
