//! `openstar-mic-bridge`: see the library's docs. Errors print
//! `OpenStar Mic bridge: …` to stderr and exit 1; wrong arguments exit 2.

use std::path::Path;
use std::process::ExitCode;

use anyhow::Context as _;
use openstar_mic_bridge::cli::{self, Action};
use openstar_mic_bridge::config::ConfigDir;
use openstar_mic_bridge::{BUILD_ID, client, wav};
use openstar_protocol::bridge::BridgeInterface;

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
    let interface = wav_interface(file)?;
    println!(
        "Reading {} channel(s) of {}",
        interface.channels, interface.device_name
    );
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async {
            tokio::select! {
                ran = client::run(config, vec![interface]) => ran,
                _ = tokio::signal::ctrl_c() => Ok(()),
            }
        })
}

/// The WAV file as an interface: its file name is the device name and
/// label, each of its channels one hardware channel.
fn wav_interface(file: &Path) -> anyhow::Result<BridgeInterface> {
    let opened =
        std::fs::File::open(file).with_context(|| format!("opening {}", file.display()))?;
    let format = wav::read_format(std::io::BufReader::new(opened))
        .with_context(|| format!("reading {}", file.display()))?;
    let name = file
        .file_name()
        .context("the WAV path names no file")?
        .to_string_lossy()
        .into_owned();
    Ok(BridgeInterface {
        device_name: name.clone(),
        label: name,
        channels: u32::from(format.channels),
    })
}
