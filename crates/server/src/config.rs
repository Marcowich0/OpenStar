//! Settings, read from environment variables only: no config file and no
//! settings screen. See the configuration table in the architecture spec (#44).

use std::fmt;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};

/// The server's settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// `OPENSTAR_ADMIN_PIN` (or `_FILE`): required, 4 to 8 digits.
    pub admin_pin: Secret,
    /// `OPENSTAR_PORT`: the one plain-HTTP port.
    pub port: u16,
    /// `OPENSTAR_PUBLIC_URL`: the join address, when it is set. No trailing slash.
    pub public_url: Option<String>,
    /// `OPENSTAR_USDB_USERNAME` / `OPENSTAR_USDB_PASSWORD` (or `_FILE` each),
    /// when both are set.
    pub usdb: Option<UsdbCredentials>,
    /// `OPENSTAR_USDB_BASE_URL`: where USDB is, without a trailing slash.
    /// Only tests change it (to the fake USDB); default `https://usdb.animux.de`.
    pub usdb_base_url: String,
    /// `OPENSTAR_YTDLP_AUTOUPDATE`: `false` never updates the copy in `appdata/bin`.
    pub ytdlp_autoupdate: bool,
    /// `OPENSTAR_LOG`: the log filter in `RUST_LOG` syntax.
    pub log: String,
    /// `OPENSTAR_SONGS_DIR`: the Library.
    pub songs_dir: PathBuf,
    /// `OPENSTAR_APPDATA_DIR`: everything OpenStar owns, the database included.
    pub appdata_dir: PathBuf,
    /// `PATH`: where child processes (ffmpeg, ffprobe, yt-dlp) are found and
    /// the `PATH` they run with. `None` keeps the process's own.
    pub tool_path: Option<String>,
}

/// The USDB login, handed to the Downloads area (#47).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsdbCredentials {
    pub username: String,
    pub password: Secret,
}

/// A value that must never reach a log: its `Debug` output is redacted.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// Wraps a value, for tests that choose their own Admin PIN.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The value itself, for the one place that needs it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

const DEFAULT_PORT: u16 = 8080;
const DEFAULT_USDB_BASE_URL: &str = "https://usdb.animux.de";

impl Config {
    /// Reads the settings from the process environment.
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    /// Settings for tests: the given folders, a fixed Admin PIN, port 0 and
    /// every other setting at its default.
    pub fn for_tests(appdata_dir: &Path, songs_dir: &Path) -> Self {
        Self {
            admin_pin: Secret("1234".to_owned()),
            port: 0,
            public_url: None,
            usdb: None,
            usdb_base_url: DEFAULT_USDB_BASE_URL.to_owned(),
            ytdlp_autoupdate: true,
            log: "info".to_owned(),
            songs_dir: songs_dir.to_path_buf(),
            appdata_dir: appdata_dir.to_path_buf(),
            tool_path: None,
        }
    }

    /// Reads the settings through `var`, which returns a variable's value if
    /// it is set. An empty value counts as unset.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let var = |name: &str| var(name).filter(|value| !value.is_empty());

        let admin_pin = secret(&var, "OPENSTAR_ADMIN_PIN")?.context(
            "OPENSTAR_ADMIN_PIN is not set: set it (or OPENSTAR_ADMIN_PIN_FILE) to 4 to 8 digits",
        )?;
        let pin_ok =
            (4..=8).contains(&admin_pin.len()) && admin_pin.bytes().all(|b| b.is_ascii_digit());
        if !pin_ok {
            // Never repeat the value: it may be a mistyped real PIN.
            bail!("OPENSTAR_ADMIN_PIN must be 4 to 8 digits (0-9)");
        }

        let username = secret(&var, "OPENSTAR_USDB_USERNAME")?;
        let password = secret(&var, "OPENSTAR_USDB_PASSWORD")?;
        let usdb = match (username, password) {
            (Some(username), Some(password)) => Some(UsdbCredentials {
                username,
                password: Secret(password),
            }),
            (None, None) => None,
            (Some(_), None) => bail!(
                "OPENSTAR_USDB_USERNAME is set but OPENSTAR_USDB_PASSWORD is not: set both or neither"
            ),
            (None, Some(_)) => bail!(
                "OPENSTAR_USDB_PASSWORD is set but OPENSTAR_USDB_USERNAME is not: set both or neither"
            ),
        };

        let public_url = var("OPENSTAR_PUBLIC_URL")
            .map(|url| {
                let url = url.trim().trim_end_matches('/').to_owned();
                let host = url
                    .strip_prefix("https://")
                    .or_else(|| url.strip_prefix("http://"));
                match host {
                    Some(host) if !host.is_empty() => Ok(url),
                    _ => Err(anyhow::anyhow!(
                        "OPENSTAR_PUBLIC_URL must be an http:// or https:// address such as https://openstar.example.org, got {url:?}"
                    )),
                }
            })
            .transpose()?;

        let usdb_base_url = match var("OPENSTAR_USDB_BASE_URL") {
            None => DEFAULT_USDB_BASE_URL.to_owned(),
            Some(url) => {
                let url = url.trim().trim_end_matches('/').to_owned();
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    bail!(
                        "OPENSTAR_USDB_BASE_URL must be an http:// or https:// address, got {url:?}"
                    );
                }
                url
            }
        };

        let ytdlp_autoupdate = match var("OPENSTAR_YTDLP_AUTOUPDATE") {
            None => true,
            Some(text) => match text.trim().to_ascii_lowercase().as_str() {
                "true" => true,
                "false" => false,
                _ => bail!("OPENSTAR_YTDLP_AUTOUPDATE must be true or false, got {text:?}"),
            },
        };

        let log = var("OPENSTAR_LOG").unwrap_or_else(|| "info".to_owned());
        if let Err(error) = tracing_subscriber::EnvFilter::try_new(&log) {
            bail!(
                "OPENSTAR_LOG must be a filter in RUST_LOG syntax such as \"info\" or \"openstar=debug,warn\", got {log:?}: {error}"
            );
        }

        let dir = |name: &str, default: &str| {
            PathBuf::from(var(name).unwrap_or_else(|| default.to_owned()))
        };

        Ok(Self {
            admin_pin: Secret(admin_pin),
            port: port(&var)?,
            public_url,
            usdb,
            usdb_base_url,
            ytdlp_autoupdate,
            log,
            songs_dir: dir("OPENSTAR_SONGS_DIR", "/songs"),
            appdata_dir: dir("OPENSTAR_APPDATA_DIR", "/appdata"),
            tool_path: var("PATH"),
        })
    }

    /// Reads only `OPENSTAR_PORT`, for `openstar healthcheck`, which needs no
    /// secrets.
    pub fn port_from_vars(var: impl Fn(&str) -> Option<String>) -> anyhow::Result<u16> {
        port(&|name: &str| var(name).filter(|value| !value.is_empty()))
    }
}

fn port(var: &impl Fn(&str) -> Option<String>) -> anyhow::Result<u16> {
    match var("OPENSTAR_PORT") {
        None => Ok(DEFAULT_PORT),
        Some(text) => match text.trim().parse::<u16>() {
            Ok(port) if port != 0 => Ok(port),
            _ => bail!("OPENSTAR_PORT must be a port number from 1 to 65535, got {text:?}"),
        },
    }
}

/// Reads `name`, or the file that `<name>_FILE` names (for Docker secrets).
/// One trailing line break of the file is dropped.
fn secret(var: &impl Fn(&str) -> Option<String>, name: &str) -> anyhow::Result<Option<String>> {
    let file_name = format!("{name}_FILE");
    match (var(name), var(&file_name)) {
        (Some(_), Some(_)) => {
            bail!("both {name} and {file_name} are set: set only one of them")
        }
        (Some(value), None) => Ok(Some(value)),
        (None, Some(path)) => {
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("reading {file_name} from {path}"))?;
            let text = text
                .strip_suffix('\n')
                .map(|t| t.strip_suffix('\r').unwrap_or(t))
                .unwrap_or(&text);
            Ok(Some(text.to_owned()).filter(|value| !value.is_empty()))
        }
        (None, None) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PIN: (&str, &str) = ("OPENSTAR_ADMIN_PIN", "2468");

    fn vars<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    fn error(pairs: &[(&str, &str)]) -> String {
        format!("{:#}", Config::from_vars(vars(pairs)).unwrap_err())
    }

    #[test]
    fn defaults_when_only_the_admin_pin_is_set() {
        let config = Config::from_vars(vars(&[PIN])).unwrap();
        assert_eq!(config.port, 8080);
        assert_eq!(config.admin_pin.expose(), "2468");
        assert_eq!(config.public_url, None);
        assert!(config.usdb.is_none());
        assert!(config.ytdlp_autoupdate);
        assert_eq!(config.log, "info");
        assert_eq!(config.songs_dir, PathBuf::from("/songs"));
        assert_eq!(config.appdata_dir, PathBuf::from("/appdata"));
        assert_eq!(config.tool_path, None);
    }

    #[test]
    fn usdb_is_the_real_site_unless_a_base_url_is_given() {
        let config = Config::from_vars(vars(&[PIN])).unwrap();
        assert_eq!(config.usdb_base_url, "https://usdb.animux.de");
        let config = Config::from_vars(vars(&[
            PIN,
            ("OPENSTAR_USDB_BASE_URL", "http://127.0.0.1:4321/"),
        ]))
        .unwrap();
        assert_eq!(config.usdb_base_url, "http://127.0.0.1:4321");
    }

    #[test]
    fn a_usdb_base_url_that_is_not_http_is_refused() {
        let message = error(&[PIN, ("OPENSTAR_USDB_BASE_URL", "usdb.example")]);
        assert!(message.contains("OPENSTAR_USDB_BASE_URL"), "{message}");
    }

    #[test]
    fn child_processes_get_the_path_read_through_the_settings() {
        let config = Config::from_vars(vars(&[PIN, ("PATH", "/stub:/usr/bin")])).unwrap();
        assert_eq!(config.tool_path.as_deref(), Some("/stub:/usr/bin"));
    }

    #[test]
    fn variables_override_the_defaults() {
        let config = Config::from_vars(vars(&[
            PIN,
            ("OPENSTAR_PORT", "9000"),
            ("OPENSTAR_PUBLIC_URL", "https://openstar.example.org"),
            ("OPENSTAR_USDB_USERNAME", "singer"),
            ("OPENSTAR_USDB_PASSWORD", "hunter2"),
            ("OPENSTAR_YTDLP_AUTOUPDATE", "false"),
            ("OPENSTAR_LOG", "openstar=debug,warn"),
            ("OPENSTAR_APPDATA_DIR", "/tmp/a"),
            ("OPENSTAR_SONGS_DIR", "/tmp/s"),
        ]))
        .unwrap();
        assert_eq!(config.port, 9000);
        assert_eq!(
            config.public_url.as_deref(),
            Some("https://openstar.example.org")
        );
        let usdb = config.usdb.unwrap();
        assert_eq!(usdb.username, "singer");
        assert_eq!(usdb.password.expose(), "hunter2");
        assert!(!config.ytdlp_autoupdate);
        assert_eq!(config.log, "openstar=debug,warn");
        assert_eq!(config.appdata_dir, PathBuf::from("/tmp/a"));
        assert_eq!(config.songs_dir, PathBuf::from("/tmp/s"));
    }

    #[test]
    fn an_empty_variable_counts_as_unset() {
        let config = Config::from_vars(vars(&[
            PIN,
            ("OPENSTAR_PUBLIC_URL", ""),
            ("OPENSTAR_PORT", ""),
        ]))
        .unwrap();
        assert_eq!(config.public_url, None);
        assert_eq!(config.port, 8080);
    }

    #[test]
    fn a_bad_port_is_refused() {
        for bad in ["0", "http", "70000"] {
            assert!(
                error(&[PIN, ("OPENSTAR_PORT", bad)]).contains("OPENSTAR_PORT"),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_missing_admin_pin_is_refused_with_a_clear_message() {
        let message = error(&[]);
        assert!(
            message.contains("OPENSTAR_ADMIN_PIN is not set"),
            "{message}"
        );
    }

    #[test]
    fn an_admin_pin_that_is_not_4_to_8_digits_is_refused() {
        for bad in ["123", "123456789", "12a4", "12 34", "١٢٣٤"] {
            let message = error(&[("OPENSTAR_ADMIN_PIN", bad)]);
            assert!(message.contains("4 to 8 digits"), "{bad}: {message}");
            assert!(
                !message.contains(bad),
                "the message repeats the PIN: {message}"
            );
        }
        for good in ["1234", "12345678", "0000"] {
            assert!(
                Config::from_vars(vars(&[("OPENSTAR_ADMIN_PIN", good)])).is_ok(),
                "{good}"
            );
        }
    }

    #[test]
    fn a_file_variant_reads_its_value_from_the_named_file() {
        let dir = tempfile::tempdir().unwrap();
        let pin = dir.path().join("pin");
        let user = dir.path().join("user");
        let password = dir.path().join("password");
        // Docker secrets usually end with a newline.
        std::fs::write(&pin, "97531\n").unwrap();
        std::fs::write(&user, "singer").unwrap();
        std::fs::write(&password, "hunter2\r\n").unwrap();
        let (pin, user, password) = (
            pin.to_str().unwrap(),
            user.to_str().unwrap(),
            password.to_str().unwrap(),
        );
        let config = Config::from_vars(vars(&[
            ("OPENSTAR_ADMIN_PIN_FILE", pin),
            ("OPENSTAR_USDB_USERNAME_FILE", user),
            ("OPENSTAR_USDB_PASSWORD_FILE", password),
        ]))
        .unwrap();
        assert_eq!(config.admin_pin.expose(), "97531");
        let usdb = config.usdb.unwrap();
        assert_eq!(usdb.username, "singer");
        assert_eq!(usdb.password.expose(), "hunter2");
    }

    #[test]
    fn an_unreadable_file_variant_is_refused_naming_the_variable() {
        let message = error(&[("OPENSTAR_ADMIN_PIN_FILE", "/nonexistent/openstar/pin")]);
        assert!(message.contains("OPENSTAR_ADMIN_PIN_FILE"), "{message}");
        assert!(message.contains("/nonexistent/openstar/pin"), "{message}");
    }

    #[test]
    fn a_variable_and_its_file_variant_together_are_refused_naming_both() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("secret");
        std::fs::write(&file, "1234").unwrap();
        let file = file.to_str().unwrap();
        for name in [
            "OPENSTAR_ADMIN_PIN",
            "OPENSTAR_USDB_USERNAME",
            "OPENSTAR_USDB_PASSWORD",
        ] {
            let file_name = format!("{name}_FILE");
            let message = error(&[PIN, (name, "1234"), (&file_name, file)]);
            assert!(
                message.contains(&format!("both {name} and {file_name} are set")),
                "{message}"
            );
        }
    }

    #[test]
    fn only_half_of_the_usdb_credentials_is_refused() {
        let message = error(&[PIN, ("OPENSTAR_USDB_USERNAME", "singer")]);
        assert!(message.contains("OPENSTAR_USDB_PASSWORD"), "{message}");
        let message = error(&[PIN, ("OPENSTAR_USDB_PASSWORD", "hunter2")]);
        assert!(message.contains("OPENSTAR_USDB_USERNAME"), "{message}");
    }

    #[test]
    fn a_public_url_must_be_http_or_https() {
        for good in ["https://openstar.example.org", "http://192.168.1.5:8080"] {
            assert!(Config::from_vars(vars(&[PIN, ("OPENSTAR_PUBLIC_URL", good)])).is_ok());
        }
        for bad in ["openstar.example.org", "ftp://x", "https://"] {
            let message = error(&[PIN, ("OPENSTAR_PUBLIC_URL", bad)]);
            assert!(message.contains("OPENSTAR_PUBLIC_URL"), "{bad}: {message}");
        }
    }

    #[test]
    fn a_public_url_loses_its_trailing_slash() {
        let config =
            Config::from_vars(vars(&[PIN, ("OPENSTAR_PUBLIC_URL", "https://x.example/")])).unwrap();
        assert_eq!(config.public_url.as_deref(), Some("https://x.example"));
    }

    #[test]
    fn ytdlp_autoupdate_takes_true_or_false_only() {
        for (text, expected) in [("true", true), ("FALSE", false), ("False", false)] {
            let config =
                Config::from_vars(vars(&[PIN, ("OPENSTAR_YTDLP_AUTOUPDATE", text)])).unwrap();
            assert_eq!(config.ytdlp_autoupdate, expected, "{text}");
        }
        let message = error(&[PIN, ("OPENSTAR_YTDLP_AUTOUPDATE", "nope")]);
        assert!(message.contains("OPENSTAR_YTDLP_AUTOUPDATE"), "{message}");
    }

    #[test]
    fn a_log_filter_that_is_not_rust_log_syntax_is_refused() {
        let message = error(&[PIN, ("OPENSTAR_LOG", "openstar=loud")]);
        assert!(message.contains("OPENSTAR_LOG"), "{message}");
    }

    #[test]
    fn secrets_never_show_in_debug_output() {
        let config = Config::from_vars(vars(&[
            ("OPENSTAR_ADMIN_PIN", "86420"),
            ("OPENSTAR_USDB_USERNAME", "singer"),
            ("OPENSTAR_USDB_PASSWORD", "hunter2"),
        ]))
        .unwrap();
        let shown = format!("{config:?} {config:#?}");
        assert!(!shown.contains("86420"), "{shown}");
        assert!(!shown.contains("hunter2"), "{shown}");
        assert!(shown.contains("singer"), "{shown}");
    }

    #[test]
    fn the_healthcheck_reads_only_the_port() {
        assert_eq!(Config::port_from_vars(vars(&[])).unwrap(), 8080);
        assert_eq!(
            Config::port_from_vars(vars(&[("OPENSTAR_PORT", "9001")])).unwrap(),
            9001
        );
    }
}
