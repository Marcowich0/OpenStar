//! `openstar-mic-bridge`: see the library's docs. Errors print
//! `OpenStar Mic bridge: …` to stderr and exit 1; wrong arguments exit 2.

use std::path::Path;
use std::process::ExitCode;

use anyhow::Context as _;
use openstar_mic_bridge::cli::{self, Action};
use openstar_mic_bridge::client::{self, Ended, Input};
use openstar_mic_bridge::config::ConfigDir;
use openstar_mic_bridge::{BUILD_ID, capture, update, wav, window};

mod uninstall;

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
        Action::Window => windowed(),
        Action::Uninstall => remove_installed(),
    };
    match ran {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("OpenStar Mic bridge: {error:#}");
            ExitCode::FAILURE
        }
    }
}

/// Opens the window and connects while it is open, offering every
/// interface in the Pro Audio profile, each captured with PipeWire.
/// Without a sound server the window lists none.
fn windowed() -> anyhow::Result<()> {
    let config = ConfigDir::locate(|name| std::env::var(name).ok())
        .context("neither XDG_CONFIG_HOME nor HOME is set")?;
    window::run(config, pipewire_inputs())
}

/// The interfaces the sound server offers now, as inputs. The list is read
/// once at start; an interface plugged in later needs a restart (#214
/// reattaches unplugged ones).
fn pipewire_inputs() -> Vec<Box<dyn Input>> {
    let discovered = match capture::interfaces() {
        Ok(discovered) => discovered,
        Err(error) => {
            eprintln!("OpenStar Mic bridge: no audio interfaces: {error:#}");
            return Vec::new();
        }
    };
    // #206 shows these in the window with Switch to Pro Audio.
    for card in &discovered.not_pro_audio {
        eprintln!(
            "OpenStar Mic bridge: {} is in {}: only Pro Audio is read",
            card.description,
            card.profile.as_deref().unwrap_or("no profile"),
        );
    }
    discovered
        .interfaces
        .into_iter()
        .map(|found| Box::new(capture::PipeWireInput::new(found)) as Box<dyn Input>)
        .collect()
}

/// Removes what the install script installed and says what went.
fn remove_installed() -> anyhow::Result<()> {
    let installed =
        uninstall::Installed::locate(|name| std::env::var(name).ok()).context("HOME is not set")?;
    let removed = installed.remove()?;
    for path in &removed {
        println!("Removed {}", path.display());
    }
    if removed.is_empty() {
        println!("Nothing to remove: the Mic bridge is not installed for this user");
    }
    println!(
        "The bridge stays approved on the OpenStar server until you forget it on the Stage's Mics screen"
    );
    Ok(())
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
    let ended = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async {
            tokio::select! {
                ran = client::run(config, inputs) => ran.map(Some),
                _ = tokio::signal::ctrl_c() => Ok(None),
            }
        })?;
    match ended {
        None => Ok(()),
        // Returns only if the new build does not start.
        Some(Ended::Updated(exe)) => Err(anyhow::Error::new(update::restart(&exe))
            .context(format!("starting the updated {}", exe.display()))),
        Some(Ended::BuildMismatch(mismatch)) => anyhow::bail!("{}", mismatch.message()),
    }
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
