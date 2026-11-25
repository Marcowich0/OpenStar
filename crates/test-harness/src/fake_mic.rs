//! The fake microphone inputs, described in `fixtures/mic/fake-mic.json` and
//! generated with the real ffmpeg: a steady tone on the pitch class of the
//! fixture Library's steady-tone Song, silence, and a multichannel WAV for the
//! Mic bridge with the tone on one channel and silence on the others.
//!
//! `just e2e` runs `openstar-harness fake-mic <dir>`; Chromium plays a file
//! to a Phone with `--use-file-for-fake-audio-capture` and loops it.

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use serde::Deserialize;

use crate::{Media, Signal};

/// `fixtures/mic/fake-mic.json`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FakeMic {
    pub sample_rate: u32,
    /// Every file's length. With the tone, it makes whole cycles, so a looped
    /// file has no click.
    pub seconds: f64,
    pub steady_tone: SteadyTone,
    pub silence: Silence,
    pub multichannel: Multichannel,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SteadyTone {
    pub file: String,
    pub hz: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Silence {
    pub file: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Multichannel {
    pub file: String,
    pub channels: u16,
    /// The 0-based channel with the steady tone; the others are silent.
    pub tone_channel: u16,
}

/// Where [`write`] put each input.
#[derive(Debug, Clone, PartialEq)]
pub struct FakeMicFiles {
    pub steady_tone: PathBuf,
    pub silence: PathBuf,
    pub multichannel: PathBuf,
}

impl FakeMic {
    /// `fixtures/mic/fake-mic.json` in this repository.
    pub fn path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/mic/fake-mic.json")
    }

    /// Reads [`FakeMic::path`].
    pub fn load() -> anyhow::Result<Self> {
        let path = Self::path();
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let mic: Self =
            serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        if mic.multichannel.tone_channel >= mic.multichannel.channels {
            bail!("the multichannel WAV's toneChannel is not one of its channels");
        }
        Ok(mic)
    }
}

/// Writes the fake mic inputs into `dest` (created if missing), with ffmpeg
/// from `PATH`.
pub fn write(dest: &Path) -> anyhow::Result<FakeMicFiles> {
    let mic = FakeMic::load()?;
    let media = Media::new();
    let (rate, seconds) = (mic.sample_rate, mic.seconds);
    let steady_tone = media.tone(&mic.steady_tone.file, mic.steady_tone.hz, seconds, rate)?;
    let silence = media.silence(&mic.silence.file, seconds, rate)?;
    let channels: Vec<Signal> = (0..mic.multichannel.channels)
        .map(|i| {
            if i == mic.multichannel.tone_channel {
                Signal::Tone(mic.steady_tone.hz)
            } else {
                Signal::Silence
            }
        })
        .collect();
    let multichannel = media.multichannel_wav(&mic.multichannel.file, &channels, seconds, rate)?;

    std::fs::create_dir_all(dest).with_context(|| format!("creating {}", dest.display()))?;
    let keep = |generated: PathBuf| -> anyhow::Result<PathBuf> {
        let target = dest.join(
            generated
                .file_name()
                .context("a generated file has a name")?,
        );
        std::fs::copy(&generated, &target)
            .with_context(|| format!("writing {}", target.display()))?;
        Ok(target)
    };
    Ok(FakeMicFiles {
        steady_tone: keep(steady_tone)?,
        silence: keep(silence)?,
        multichannel: keep(multichannel)?,
    })
}
