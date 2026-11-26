//! `--uninstall`: removes what the install script (`install/install.sh`)
//! put on this computer: the binary in `~/.local/bin`, the app-menu entry,
//! its icon and the config folder with the server address and the approval
//! token. The server is not told: the bridge stays approved there, shown as
//! closed, until it is forgotten on the Stage.

use std::path::{Path, PathBuf};

use anyhow::Context as _;

use openstar_mic_bridge::config::ConfigDir;

/// Everything the install script writes, worked out the way it does:
/// `XDG_DATA_HOME` and `XDG_CONFIG_HOME` count only when absolute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub binary: PathBuf,
    pub menu_entry: PathBuf,
    pub icon: PathBuf,
    pub config: ConfigDir,
}

impl Installed {
    /// `None` without `HOME`.
    pub fn locate(var: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let set = |name: &str| var(name).filter(|value| !value.is_empty());
        let home = PathBuf::from(set("HOME")?);
        let data_home = set("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".local/share"));
        Some(Self {
            binary: home.join(".local/bin/openstar-mic-bridge"),
            menu_entry: data_home.join("applications/openstar-mic-bridge.desktop"),
            icon: data_home.join("icons/hicolor/scalable/apps/openstar-mic-bridge.svg"),
            config: ConfigDir::locate(var)?,
        })
    }

    /// Removes every part that is there and returns what it removed. A part
    /// already gone is no error, so running it twice is safe.
    pub fn remove(&self) -> anyhow::Result<Vec<PathBuf>> {
        let mut removed = Vec::new();
        for file in [&self.binary, &self.menu_entry, &self.icon] {
            if remove_file(file)? {
                removed.push(file.clone());
            }
        }
        let config = self.config.path();
        match std::fs::remove_dir_all(config) {
            Ok(()) => removed.push(config.to_path_buf()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("removing {}", config.display()));
            }
        }
        Ok(removed)
    }
}

fn remove_file(file: &Path) -> anyhow::Result<bool> {
    match std::fs::remove_file(file) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("removing {}", file.display())),
    }
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
    fn the_parts_follow_home_and_absolute_xdg_folders_like_the_script() {
        let plain = Installed::locate(vars(&[("HOME", "/home/a")])).unwrap();
        assert_eq!(
            plain.menu_entry,
            Path::new("/home/a/.local/share/applications/openstar-mic-bridge.desktop")
        );
        let xdg = Installed::locate(vars(&[
            ("HOME", "/home/a"),
            ("XDG_DATA_HOME", "/data"),
            ("XDG_CONFIG_HOME", "relative"),
        ]))
        .unwrap();
        assert_eq!(
            xdg.binary,
            Path::new("/home/a/.local/bin/openstar-mic-bridge")
        );
        assert_eq!(
            xdg.icon,
            Path::new("/data/icons/hicolor/scalable/apps/openstar-mic-bridge.svg")
        );
        assert_eq!(
            xdg.config.path(),
            Path::new("/home/a/.config/openstar-mic-bridge")
        );
        assert_eq!(Installed::locate(vars(&[])), None);
    }

    #[test]
    fn removing_twice_is_safe() {
        let home = tempfile::tempdir().unwrap();
        let home_text = home.path().to_str().unwrap();
        let installed = Installed::locate(vars(&[("HOME", home_text)])).unwrap();
        std::fs::create_dir_all(installed.config.path()).unwrap();
        std::fs::write(installed.config.path().join("token"), "t").unwrap();
        assert_eq!(installed.remove().unwrap().len(), 1);
        assert_eq!(installed.remove().unwrap(), Vec::<PathBuf>::new());
    }
}
