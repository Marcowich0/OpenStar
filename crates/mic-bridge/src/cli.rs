//! The command line: `--version` prints the build, `--wav <file>` runs
//! headless on a WAV file. (`--uninstall` is #207's.)

use std::path::PathBuf;

/// What the bridge was asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Version,
    Help,
    /// Run headless, reading the WAV file's channels as one interface.
    Wav(PathBuf),
}

pub const USAGE: &str = "\
Usage: openstar-mic-bridge [--wav <file>] [--version]

  --wav <file>  run without a window, reading each channel of a WAV file
                as one input channel
  --version     print the build identifier";

/// Parses the arguments after the program name.
pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Action, String> {
    let mut args = args.into_iter();
    let action = match args.next().as_deref() {
        Some("--version" | "-V") => Action::Version,
        Some("--help" | "-h") => Action::Help,
        Some("--wav") => match args.next() {
            Some(file) if !file.is_empty() => Action::Wav(PathBuf::from(file)),
            _ => return Err("--wav needs a file".into()),
        },
        Some(other) => return Err(format!("unknown argument {other:?}")),
        // The window and real capture come with #204 and #205.
        None => return Err("this build runs only headless: use --wav <file>".into()),
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
        assert!(parse_strs(&[]).is_err());
    }
}
