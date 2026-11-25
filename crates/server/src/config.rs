//! Settings, read from environment variables only.

use std::path::PathBuf;

use anyhow::{Context, bail};

/// The server's settings. See the configuration table in the architecture spec.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// `OPENSTAR_PORT`: the one plain-HTTP port.
    pub port: u16,
    /// `OPENSTAR_APPDATA_DIR`: everything OpenStar owns, the database included.
    pub appdata_dir: PathBuf,
    /// `OPENSTAR_SONGS_DIR`: the Library.
    pub songs_dir: PathBuf,
}

impl Config {
    /// Reads the settings from the process environment.
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    /// Reads the settings through `var`, which returns a variable's value if it is set.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let port = match var("OPENSTAR_PORT") {
            None => 8080,
            Some(text) => match text.trim().parse::<u16>() {
                Ok(port) if port != 0 => port,
                _ => bail!("OPENSTAR_PORT must be a port number from 1 to 65535, got {text:?}"),
            },
        };
        let dir = |name: &str, default: &str| -> anyhow::Result<PathBuf> {
            let value = var(name).unwrap_or_else(|| default.to_owned());
            if value.is_empty() {
                bail!("{name} must not be empty");
            }
            Ok(PathBuf::from(value))
        };
        Ok(Self {
            port,
            appdata_dir: dir("OPENSTAR_APPDATA_DIR", "/appdata").context("reading settings")?,
            songs_dir: dir("OPENSTAR_SONGS_DIR", "/songs").context("reading settings")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    #[test]
    fn defaults_when_nothing_is_set() {
        let config = Config::from_vars(vars(&[])).unwrap();
        assert_eq!(
            config,
            Config {
                port: 8080,
                appdata_dir: "/appdata".into(),
                songs_dir: "/songs".into()
            }
        );
    }

    #[test]
    fn variables_override_the_defaults() {
        let config = Config::from_vars(vars(&[
            ("OPENSTAR_PORT", "9000"),
            ("OPENSTAR_APPDATA_DIR", "/tmp/a"),
            ("OPENSTAR_SONGS_DIR", "/tmp/s"),
        ]))
        .unwrap();
        assert_eq!(config.port, 9000);
        assert_eq!(config.appdata_dir, PathBuf::from("/tmp/a"));
        assert_eq!(config.songs_dir, PathBuf::from("/tmp/s"));
    }

    #[test]
    fn a_bad_port_is_refused() {
        for bad in ["0", "http", "70000"] {
            assert!(
                Config::from_vars(vars(&[("OPENSTAR_PORT", bad)])).is_err(),
                "{bad}"
            );
        }
    }
}
