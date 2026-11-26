//! The bridge always runs the exact build of its server (v1 spec #51).
//! When the server answers the hello with its own, different build
//! ([`openstar_protocol::ServerMessage::BridgeUpdate`]), newer or older, the
//! bridge downloads `/bridge/openstar-mic-bridge`, checks it against the
//! SHA-256 the server publishes beside it, writes it next to itself, swaps it
//! in with an atomic rename and restarts into it. There is no prompt, no
//! protocol version and no compatible range.
//!
//! A bridge that cannot write its own file (copied into `/usr/bin`, say)
//! does not connect: it says which builds differ and how to install the
//! server's. The approval token and the settings live in the config folder
//! ([`crate::config`]), which an update never touches.
//!
//! [`plan`] and [`SelfFile::replace`] are the decision and the swap, tested
//! here; [`download`] and [`restart`] are the network and `exec` around them.

use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context as _;
use sha2::{Digest as _, Sha256};

/// The binary's name, also its name under `/bridge/`.
pub const BINARY: &str = "openstar-mic-bridge";

/// How long a download of the bridge may take.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

/// What the bridge does about the server's build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// The same build: connect.
    Connect,
    /// Another build, and the bridge can replace itself: update to `build`.
    Update { build: String },
    /// Another build, and the bridge cannot replace itself: do not connect.
    Mismatch(Mismatch),
}

/// The two builds of a bridge that cannot update itself, and how to fix it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mismatch {
    /// This bridge's build.
    pub bridge: String,
    /// The server's build.
    pub server: String,
    /// The one-line install from the server, as the Stage shows it.
    pub install_command: String,
}

impl Mismatch {
    /// "This Mic bridge is 1.3.2, the server is 1.4.0".
    pub fn message(&self) -> String {
        format!(
            "This Mic bridge is {}, the server is {}",
            self.bridge, self.server
        )
    }
}

/// What to do when this bridge is `bridge` and the server at
/// `server_address` is `server`; `can_replace` says whether the bridge can
/// write its own file.
pub fn plan(bridge: &str, server: &str, server_address: &str, can_replace: bool) -> Plan {
    if bridge == server {
        Plan::Connect
    } else if can_replace {
        Plan::Update {
            build: server.to_owned(),
        }
    } else {
        Plan::Mismatch(Mismatch {
            bridge: bridge.to_owned(),
            server: server.to_owned(),
            install_command: install_command(server_address),
        })
    }
}

/// The one-line install, as the Stage's Add a Mic bridge panel shows it
/// (`web/src/bridge/InstallCommand.tsx`).
pub fn install_command(server_address: &str) -> String {
    format!(
        "curl -fsSL {}/bridge/install.sh | sh",
        server_address.trim_end_matches('/')
    )
}

/// "Updating to 1.4.0…", the window's and headless mode's line.
pub fn updating_line(build: &str) -> String {
    format!("Updating to {build}…")
}

/// The hex SHA-256 in the server's `openstar-mic-bridge.sha256`
/// (`<hex>  openstar-mic-bridge`).
fn published_digest(published: &str) -> anyhow::Result<String> {
    let digest = published
        .split_whitespace()
        .next()
        .context("the published checksum is empty")?;
    anyhow::ensure!(
        digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()),
        "the published checksum is not a SHA-256: {digest:?}"
    );
    Ok(digest.to_ascii_lowercase())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// The bridge's own file, which an update replaces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfFile {
    path: PathBuf,
}

impl SelfFile {
    /// The running binary. Taken at start, before any swap: after one,
    /// the kernel names the old file "(deleted)".
    pub fn current() -> anyhow::Result<Self> {
        Ok(Self::at(
            std::env::current_exe().context("finding the bridge's own file")?,
        ))
    }

    pub fn at(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The new copy is written here first, next to the binary, so the
    /// rename that swaps it in stays on one file system.
    fn partial(&self) -> PathBuf {
        let name = self
            .path
            .file_name()
            .map_or_else(|| BINARY.into(), |name| name.to_string_lossy().into_owned());
        self.path.with_file_name(format!(".{name}.update"))
    }

    /// Whether the bridge can replace itself: it can write a file next to
    /// itself (the rename needs no more).
    pub fn can_replace(&self) -> bool {
        let partial = self.partial();
        let _ = std::fs::remove_file(&partial);
        let wrote = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .is_ok();
        let _ = std::fs::remove_file(&partial);
        wrote
    }

    /// Writes `binary` next to the bridge, checks what was written against
    /// `published` (the server's `.sha256`) and swaps it in with an atomic
    /// rename. A copy that fails the check is discarded and the bridge is
    /// left as it was.
    pub fn replace(&self, binary: &[u8], published: &str) -> anyhow::Result<()> {
        let expected = published_digest(published)?;
        let partial = self.partial();
        let _ = std::fs::remove_file(&partial);
        let written = write_executable(&partial, binary).and_then(|()| {
            let actual = hex(&Sha256::digest(
                std::fs::read(&partial).context("reading the downloaded copy back")?,
            ));
            anyhow::ensure!(
                actual == expected,
                "the downloaded Mic bridge does not match the server's SHA-256 \
                 (expected {expected}, got {actual}): discarded"
            );
            Ok(())
        });
        if let Err(error) = written {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
        let swapped = std::fs::rename(&partial, &self.path);
        if swapped.is_err() {
            let _ = std::fs::remove_file(&partial);
        }
        swapped.with_context(|| format!("swapping in {}", self.path.display()))
    }

    /// This binary's build: [`crate::BUILD_ID`].
    ///
    /// Test builds only (debug assertions on, never a release): a binary
    /// whose file ends in `\nopenstar-mic-bridge-test-build=<id>\n` calls
    /// itself `<id>`, so an integration test can make "another build" from
    /// the one it has, without compiling a second one.
    pub fn build(&self) -> String {
        #[cfg(debug_assertions)]
        if let Some(build) = test_build(&self.path) {
            return build;
        }
        crate::BUILD_ID.to_owned()
    }
}

/// The marker before a test build's identifier at the end of its file.
pub const TEST_BUILD_MARKER: &str = "\nopenstar-mic-bridge-test-build=";

#[cfg(debug_assertions)]
fn test_build(path: &Path) -> Option<String> {
    use std::io::{Read as _, Seek as _, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.seek(SeekFrom::End(0)).ok()?;
    let tail_length = length.min(128);
    file.seek(SeekFrom::Start(length - tail_length)).ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    let tail = String::from_utf8_lossy(&tail);
    let build = tail.rsplit_once(TEST_BUILD_MARKER)?.1.strip_suffix('\n')?;
    (!build.is_empty() && !build.contains('\n')).then(|| build.to_owned())
}

fn write_executable(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o755)
        .open(path)
        .with_context(|| format!("writing {}", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("writing {}", path.display()))?;
    file.sync_all()?;
    Ok(())
}

/// Downloads the server's bridge and its published checksum from
/// `/bridge/` on `server_address` (`http://` or `https://`).
pub async fn download(server_address: &str) -> anyhow::Result<(Vec<u8>, String)> {
    let base = format!("{}/bridge/{BINARY}", server_address.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()?;
    let get = |url: String| {
        let client = client.clone();
        async move {
            let response = client
                .get(&url)
                .send()
                .await
                .with_context(|| format!("downloading {url}"))?
                .error_for_status()
                .with_context(|| format!("downloading {url}"))?;
            anyhow::Ok(response.bytes().await?.to_vec())
        }
    };
    let published = String::from_utf8(get(format!("{base}.sha256")).await?)
        .context("the published checksum is not text")?;
    let binary = get(base).await?;
    Ok((binary, published))
}

/// Starts the new build in place of this process, with the same
/// arguments. Returns only if that fails.
pub fn restart(exe: &Path) -> std::io::Error {
    std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .exec()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "https://openstar.example";

    fn published(bytes: &[u8]) -> String {
        format!("{}  {BINARY}\n", hex(&Sha256::digest(bytes)))
    }

    /// A bridge "installed" in a temporary folder.
    fn installed(contents: &[u8]) -> (tempfile::TempDir, SelfFile) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(BINARY);
        std::fs::write(&path, contents).unwrap();
        (dir, SelfFile::at(path))
    }

    #[test]
    fn the_same_build_connects() {
        assert_eq!(plan("1.4.0", "1.4.0", SERVER, true), Plan::Connect);
        assert_eq!(plan("1.4.0", "1.4.0", SERVER, false), Plan::Connect);
    }

    #[test]
    fn a_newer_or_older_server_build_updates() {
        for (bridge, server) in [
            ("1.3.2", "1.4.0"),
            ("1.4.0", "1.3.2"),
            ("dev", "edge-abc1234"),
        ] {
            assert_eq!(
                plan(bridge, server, SERVER, true),
                Plan::Update {
                    build: server.into()
                }
            );
        }
        assert_eq!(updating_line("1.4.0"), "Updating to 1.4.0…");
    }

    #[test]
    fn a_bridge_that_cannot_write_its_file_shows_the_mismatch_and_the_install_command() {
        let Plan::Mismatch(mismatch) = plan("1.3.2", "1.4.0", "https://openstar.example/", false)
        else {
            panic!("a mismatch");
        };
        assert_eq!(
            mismatch.message(),
            "This Mic bridge is 1.3.2, the server is 1.4.0"
        );
        assert_eq!(
            mismatch.install_command,
            "curl -fsSL https://openstar.example/bridge/install.sh | sh"
        );
    }

    #[test]
    fn a_copy_that_matches_its_checksum_is_swapped_in_executable() {
        let (dir, me) = installed(b"old build");
        assert!(me.can_replace());
        me.replace(b"new build", &published(b"new build")).unwrap();
        assert_eq!(std::fs::read(me.path()).unwrap(), b"new build");
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(me.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            1,
            "nothing left beside it"
        );
    }

    #[test]
    fn a_copy_failing_its_checksum_is_discarded_and_the_bridge_is_unchanged() {
        let (dir, me) = installed(b"old build");
        let error = me
            .replace(b"tampered build", &published(b"new build"))
            .unwrap_err();
        assert!(format!("{error:#}").contains("SHA-256"), "{error:#}");
        assert_eq!(std::fs::read(me.path()).unwrap(), b"old build");
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            1,
            "the bad copy is gone"
        );
        assert!(me.replace(b"x", "not a checksum").is_err());
        assert_eq!(std::fs::read(me.path()).unwrap(), b"old build");
    }

    #[test]
    fn a_bridge_in_a_folder_it_cannot_write_cannot_replace_itself() {
        use std::os::unix::fs::PermissionsExt as _;
        let (dir, me) = installed(b"old build");
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        // Root writes anyway; the rule is about an ordinary user.
        let root = std::fs::write(dir.path().join("probe"), b"").is_ok();
        let can = me.can_replace();
        let replaced = me.replace(b"new", &published(b"new"));
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        if !root {
            assert!(!can);
            assert!(replaced.is_err());
            assert_eq!(std::fs::read(me.path()).unwrap(), b"old build");
        }
    }

    #[test]
    fn a_test_build_names_itself_from_the_end_of_its_file() {
        let (_dir, me) = installed(b"\x7fELF...");
        assert_eq!(me.build(), crate::BUILD_ID);
        let (_dir, me) = installed(format!("\x7fELF...{TEST_BUILD_MARKER}1.3.2\n").as_bytes());
        assert_eq!(me.build(), "1.3.2");
    }
}
