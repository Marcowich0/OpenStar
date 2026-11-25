//! `openstar-mic-bridge`: see the library's docs. Errors print
//! `OpenStar Mic bridge: …` to stderr and exit 1; wrong arguments exit 2.

use std::path::Path;
use std::process::ExitCode;

use anyhow::Context as _;
use openstar_mic_bridge::cli::{self, Action};
use openstar_mic_bridge::config::ConfigDir;
use openstar_mic_bridge::client::{self, Input};
use openstar_mic_bridge::{BUILD_ID, wav};

fn main() -> ExitCode {
    let action = match cli::parse(std::env::args().skip(1)) {
        Ok(action) => action,
        Err(error) => {
            eprintln!("openstar-mic-bridge: {error}\n\n{}", cli::USAGE);
            return ExitCode::from(2);
        }
    };
    let ran = match action {
        Action::Version => {
            println!("{BUILD_ID}");
            Ok(())
        }
        Action::Help => {
            println!("{}", cli::USAGE);
            Ok(())
        }
        Action::Wav(file) => headless(&file),
    };
    match ran {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("OpenStar Mic bridge: {error:#}");
            ExitCode::FAILURE
        }
    }
}

/// Runs without a window, offering the WAV file's channels as one interface.
fn headless(file: &Path) -> anyhow::Result<()> {
    let config = ConfigDir::locate(|name| std::env::var(name).ok())
        .context("neither XDG_CONFIG_HOME nor HOME is set")?;
    // Said before the file is opened, so a missing address is the first fix.
    config.server()?;
    let input = wav_input(file)?;
    println!(
        "Reading {} channel(s) of {}",
        input.interface().channels,
        input.interface().device_name
    );
    let inputs: Vec<Box<dyn Input>> = vec![Box::new(input)];
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async {
            tokio::select! {
                ran = client::run(config, inputs) => ran,
                _ = tokio::signal::ctrl_c() => Ok(()),
            }
        })
}

/// The WAV file as an interface, named by its file name.
fn wav_input(file: &Path) -> anyhow::Result<wav::WavInput> {
    let opened =
        std::fs::File::open(file).with_context(|| format!("opening {}", file.display()))?;
    let audio = wav::read_audio(std::io::BufReader::new(opened))
        .with_context(|| format!("reading {}", file.display()))?;
    let name = file
        .file_name()
        .context("the WAV path names no file")?
        .to_string_lossy()
        .into_owned();
    Ok(wav::WavInput::new(name, audio))
}
