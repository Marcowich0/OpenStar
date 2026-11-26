//! The command line: no argument opens the window, `--version` prints the
//! build, `--wav <file>` runs headless on a WAV file, `--uninstall` removes
//! what the install script installed.

use std::path::PathBuf;

/// What the bridge was asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Open the window and connect while it is open.
    Window,
    Version,
    Help,
    /// Run headless, reading the WAV file's channels as one interface.
    Wav(PathBuf),
    /// Remove the binary, the app-menu entry, its icon and the config.
    Uninstall,
}

pub const USAGE: &str = "\
Usage: openstar-mic-bridge [--wav <file>] [--version] [--uninstall]

  (no option)   open the window; the bridge is connected while it is open

  --wav <file>  run without a window, reading each channel of a WAV file
                as one input channel
  --version     print the build identifier
  --uninstall   remove the bridge, its app-menu entry, its icon and its
                config (server address and approval token) from this
                computer; it stays approved on the server until forgotten";

/// Parses the arguments after the program name.
pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Action, String> {
    let mut args = args.into_iter();
    let action = match args.next().as_deref() {
        Some("--version" | "-V") => Action::Version,
        Some("--help" | "-h") => Action::Help,
        Some("--uninstall") => Action::Uninstall,
        Some("--wav") => match args.next() {
            Some(file) if !file.is_empty() => Action::Wav(PathBuf::from(file)),
            _ => return Err("--wav needs a file".into()),
        },
        Some(other) => return Err(format!("unknown argument {other:?}")),
        None => Action::Window,
    };
    match args.next() {
        None => Ok(action),
        Some(extra) => Err(format!("unexpected argument {extra:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_strs(args: &[&str]) -> Result<Action, String> {
        parse(args.iter().map(|a| (*a).to_owned()))
    }

    #[test]
    fn known_arguments() {
        assert_eq!(parse_strs(&["--version"]), Ok(Action::Version));
        assert_eq!(parse_strs(&["--uninstall"]), Ok(Action::Uninstall));
        assert_eq!(
            parse_strs(&["--wav", "mics.wav"]),
            Ok(Action::Wav("mics.wav".into()))
        );
    }

    #[test]
    fn wrong_arguments_are_refused() {
        assert!(parse_strs(&["--wav"]).is_err());
        assert!(parse_strs(&["--version", "x"]).is_err());
        assert!(parse_strs(&["--loud"]).is_err());
    }

    #[test]
    fn without_arguments_it_opens_the_window() {
        assert_eq!(parse_strs(&[]), Ok(Action::Window));
    }
}
