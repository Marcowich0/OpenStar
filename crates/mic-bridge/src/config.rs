//! The bridge's config folder, `~/.config/openstar-mic-bridge/` (or under
//! `XDG_CONFIG_HOME`): the server address the install script writes
//! (`server`, one line) and the approval token the server hands out
//! (`token`, readable by its owner alone). Both survive updates.

use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};

use anyhow::Context as _;

/// The folder's name under the config home.
pub const FOLDER: &str = "openstar-mic-bridge";
const SERVER_FILE: &str = "server";
const TOKEN_FILE: &str = "token";

/// The bridge's config folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigDir {
    path: PathBuf,
}

impl ConfigDir {
    /// `$XDG_CONFIG_HOME/openstar-mic-bridge` when `XDG_CONFIG_HOME` is an
    /// absolute path (the XDG rule: a relative one is ignored), otherwise
    /// `$HOME/.config/openstar-mic-bridge`. `None` without either.
    pub fn locate(var: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let set = |name| var(name).filter(|value| !value.is_empty());
        let home = set("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| set("HOME").map(|home| Path::new(&home).join(".config")))?;
        Some(Self::at(home.join(FOLDER)))
    }

    pub fn at(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn server_file(&self) -> PathBuf {
        self.path.join(SERVER_FILE)
    }

    /// The server address, as written (for example `http://10.0.0.5:8080`).
    pub fn server(&self) -> anyhow::Result<String> {
        let file = self.server_file();
        let missing = || {
            format!(
                "No server address: run the install command from the Stage's Mics screen again, \
                 or write the address into {}",
                file.display()
            )
        };
        let text = std::fs::read_to_string(&file).with_context(missing)?;
        let address = text.trim();
        anyhow::ensure!(!address.is_empty(), missing());
        Ok(address.to_owned())
    }

    /// The approval token, if the bridge has one.
    pub fn token(&self) -> Option<String> {
        let text = std::fs::read_to_string(self.path.join(TOKEN_FILE)).ok()?;
        let token = text.trim();
        (!token.is_empty()).then(|| token.to_owned())
    }

    /// Keeps the approval token, replacing any old one, readable by its
    /// owner alone. Written beside it first, then renamed, so a crash never
    /// leaves half a token.
    pub fn save_token(&self, token: &str) -> anyhow::Result<()> {
        std::fs::create_dir_all(&self.path)
            .with_context(|| format!("creating {}", self.path.display()))?;
        let partial = self.path.join(".token.partial");
        let target = self.path.join(TOKEN_FILE);
        let _ = std::fs::remove_file(&partial);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&partial)
            .with_context(|| format!("writing {}", partial.display()))?;
        writeln!(file, "{token}")?;
        file.sync_all()?;
        std::fs::rename(&partial, &target)
            .with_context(|| format!("writing {}", target.display()))?;
        Ok(())
    }
}

/// The WebSocket address of a server: `http://host` → `ws://host/ws/bridge`.
pub fn bridge_socket_url(server: &str) -> anyhow::Result<String> {
    let server = server.trim_end_matches('/');
    if let Some(rest) = server.strip_prefix("http://") {
        return Ok(format!("ws://{rest}/ws/bridge"));
    }
    if server.starts_with("https://") {
        // The update ticket (#209) brings HTTPS with the self-update download.
        anyhow::bail!(
            "This Mic bridge build cannot reach an https:// server yet: use its http:// address"
        );
    }
    anyhow::bail!("The server address must start with http://, got {server:?}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        }
    }

    #[test]
    fn the_folder_is_under_xdg_config_home_when_it_is_set() {
        let dir = ConfigDir::locate(vars(&[("XDG_CONFIG_HOME", "/tmp/x"), ("HOME", "/home/a")]));
        assert_eq!(dir.unwrap().path(), Path::new("/tmp/x/openstar-mic-bridge"));
    }

    #[test]
    fn the_folder_is_under_home_otherwise_or_when_xdg_config_home_is_relative() {
        for given in [
            vec![("HOME", "/home/a")],
            vec![("XDG_CONFIG_HOME", "rel"), ("HOME", "/home/a")],
        ] {
            let dir = ConfigDir::locate(vars(&given)).unwrap();
            assert_eq!(dir.path(), Path::new("/home/a/.config/openstar-mic-bridge"));
        }
        assert_eq!(ConfigDir::locate(vars(&[])), None);
    }

    #[test]
    fn the_server_address_is_read_trimmed() {
        let temp = tempfile::tempdir().unwrap();
        let dir = ConfigDir::at(temp.path().to_owned());
        assert!(dir.server().is_err());
        std::fs::write(dir.server_file(), "http://10.0.0.5:8080\n").unwrap();
        assert_eq!(dir.server().unwrap(), "http://10.0.0.5:8080");
    }

    #[test]
    fn a_saved_token_is_read_back_and_replaces_the_old_one() {
        let temp = tempfile::tempdir().unwrap();
        let dir = ConfigDir::at(temp.path().join("openstar-mic-bridge"));
        assert_eq!(dir.token(), None);
        dir.save_token("first").unwrap();
        dir.save_token("second").unwrap();
        assert_eq!(dir.token().as_deref(), Some("second"));
    }

    #[test]
    fn the_socket_address_follows_the_server_address() {
        assert_eq!(
            bridge_socket_url("http://10.0.0.5:8080/").unwrap(),
            "ws://10.0.0.5:8080/ws/bridge"
        );
        assert!(bridge_socket_url("10.0.0.5").is_err());
        assert!(bridge_socket_url("https://openstar.example").is_err());
    }
}
