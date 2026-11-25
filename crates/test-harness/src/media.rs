//! Test-time media made with the real ffmpeg.
//!
//! Every file goes into the [`Media`] value's own temporary folder, which is
//! removed when it is dropped, so generated media never lands in the repo.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, bail};
use tempfile::TempDir;

/// One channel's signal in [`Media::multichannel_wav`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Signal {
    /// A sine tone at this frequency in Hz.
    Tone(f64),
    /// White noise at this amplitude (0 to 1).
    Noise(f64),
    /// Digital silence.
    Silence,
}

/// Makes media files with ffmpeg in a temporary folder.
pub struct Media {
    ffmpeg: PathBuf,
    dir: TempDir,
}

impl Media {
    /// Uses `ffmpeg` from `PATH`.
    pub fn new() -> Self {
        Self::with_ffmpeg("ffmpeg")
    }

    /// Uses the ffmpeg at `program` (a path, or a name looked up on `PATH`).
    pub fn with_ffmpeg(program: impl Into<PathBuf>) -> Self {
        Self {
            ffmpeg: program.into(),
            dir: tempfile::Builder::new()
                .prefix("openstar-media-")
                .tempdir()
                .expect("creating a temporary media folder"),
        }
    }

    /// The temporary folder every file is written to.
    pub fn dir(&self) -> &Path {
        self.dir.path()
    }

    /// A sine tone of `frequency` Hz, `seconds` long, mono at `sample_rate`.
    /// The container follows `name`'s extension (`.wav`, `.ogg`, `.m4a`, …).
    pub fn tone(
        &self,
        name: &str,
        frequency: f64,
        seconds: f64,
        sample_rate: u32,
    ) -> anyhow::Result<PathBuf> {
        self.sine_melody(name, &[(frequency, seconds)], sample_rate)
    }

    /// Sine notes one after another: each `(frequency Hz, seconds)`. A
    /// frequency of 0 is a rest (silence).
    pub fn sine_melody(
        &self,
        name: &str,
        notes: &[(f64, f64)],
        sample_rate: u32,
    ) -> anyhow::Result<PathBuf> {
        if notes.is_empty() {
            bail!("a melody needs at least one note");
        }
        let mut args = Vec::new();
        for &(frequency, seconds) in notes {
            args.extend(lavfi(&signal_source(
                if frequency > 0.0 {
                    Signal::Tone(frequency)
                } else {
                    Signal::Silence
                },
                seconds,
                sample_rate,
            )));
        }
        let inputs: String = (0..notes.len()).map(|i| format!("[{i}:a]")).collect();
        args.extend([
            "-filter_complex".to_owned(),
            format!("{inputs}concat=n={}:v=0:a=1[out]", notes.len()),
            "-map".to_owned(),
            "[out]".to_owned(),
        ]);
        self.run(name, args)
    }

    /// White noise at `amplitude` (0 to 1), mono.
    pub fn noise(
        &self,
        name: &str,
        amplitude: f64,
        seconds: f64,
        sample_rate: u32,
    ) -> anyhow::Result<PathBuf> {
        self.run(
            name,
            lavfi(&signal_source(
                Signal::Noise(amplitude),
                seconds,
                sample_rate,
            )),
        )
    }

    /// Digital silence, mono.
    pub fn silence(&self, name: &str, seconds: f64, sample_rate: u32) -> anyhow::Result<PathBuf> {
        self.run(
            name,
            lavfi(&signal_source(Signal::Silence, seconds, sample_rate)),
        )
    }

    /// A 16-bit WAV with one channel per entry of `channels`, in order.
    pub fn multichannel_wav(
        &self,
        name: &str,
        channels: &[Signal],
        seconds: f64,
        sample_rate: u32,
    ) -> anyhow::Result<PathBuf> {
        if channels.is_empty() || channels.len() > WAV_CHANNEL_ORDER.len() {
            bail!(
                "a multichannel WAV has 1 to {} channels, got {}",
                WAV_CHANNEL_ORDER.len(),
                channels.len()
            );
        }
        let mut args = Vec::new();
        for &signal in channels {
            args.extend(lavfi(&signal_source(signal, seconds, sample_rate)));
        }
        let inputs: String = (0..channels.len()).map(|i| format!("[{i}:a]")).collect();
        args.extend([
            "-filter_complex".to_owned(),
            // Input i becomes the i-th speaker in WAV's channel order, so the
            // file's channel i carries `channels[i]` (a plain `Nc` layout
            // would let ffmpeg reorder them).
            {
                let speakers = &WAV_CHANNEL_ORDER[..channels.len()];
                let map: Vec<String> = speakers
                    .iter()
                    .enumerate()
                    .map(|(i, speaker)| format!("{i}.0-{speaker}"))
                    .collect();
                format!(
                    "{inputs}join=inputs={n}:channel_layout={layout}:map={map}[out]",
                    n = channels.len(),
                    layout = speakers.join("+"),
                    map = map.join("|")
                )
            },
            "-map".to_owned(),
            "[out]".to_owned(),
            "-c:a".to_owned(),
            "pcm_s16le".to_owned(),
        ]);
        self.run(name, args)
    }

    /// A tiny video (64×36, 10 fps, a test pattern with a 440 Hz tone),
    /// `seconds` long. The container follows `name`'s extension.
    pub fn tiny_video(&self, name: &str, seconds: f64) -> anyhow::Result<PathBuf> {
        let mut args = lavfi(&format!("testsrc=size=64x36:rate=10:duration={seconds}"));
        args.extend(lavfi(&signal_source(Signal::Tone(440.0), seconds, 44_100)));
        args.extend([
            "-pix_fmt".to_owned(),
            "yuv420p".to_owned(),
            "-shortest".to_owned(),
        ]);
        self.run(name, args)
    }

    /// Runs ffmpeg with `args` and the output file `name` in the media folder.
    fn run(&self, name: &str, args: Vec<String>) -> anyhow::Result<PathBuf> {
        let output = self.output_path(name)?;
        let result = Command::new(&self.ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"])
            .args(&args)
            .arg(&output)
            .output();
        let result = match result {
            Ok(result) => result,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => bail!(
                "ffmpeg was not found ({}): install ffmpeg to run the tests that generate media; \
                 CI's setup installs it",
                self.ffmpeg.display()
            ),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("running ffmpeg ({})", self.ffmpeg.display()));
            }
        };
        if !result.status.success() {
            bail!(
                "ffmpeg failed making {name} ({}): {}",
                result.status,
                String::from_utf8_lossy(&result.stderr).trim()
            );
        }
        Ok(output)
    }

    /// `name` inside the media folder. Only a plain file name is accepted, so
    /// nothing is ever written outside the temporary folder.
    fn output_path(&self, name: &str) -> anyhow::Result<PathBuf> {
        let path = Path::new(name);
        let is_plain_name = path.components().count() == 1
            && path
                .file_name()
                .is_some_and(|file| file == path.as_os_str());
        if !is_plain_name {
            bail!("media file names must be plain file names, got {name:?}");
        }
        Ok(self.dir.path().join(name))
    }
}

impl Default for Media {
    fn default() -> Self {
        Self::new()
    }
}

/// The speaker positions in the order a WAV file stores its channels.
const WAV_CHANNEL_ORDER: [&str; 18] = [
    "FL", "FR", "FC", "LFE", "BL", "BR", "FLC", "FRC", "BC", "SL", "SR", "TC", "TFL", "TFC", "TFR",
    "TBL", "TBC", "TBR",
];

/// An ffmpeg lavfi source for one mono `signal`.
fn signal_source(signal: Signal, seconds: f64, sample_rate: u32) -> String {
    match signal {
        Signal::Tone(frequency) => {
            format!("sine=frequency={frequency}:sample_rate={sample_rate}:duration={seconds}")
        }
        Signal::Noise(amplitude) => format!(
            "anoisesrc=color=white:amplitude={amplitude}:sample_rate={sample_rate}:duration={seconds}"
        ),
        Signal::Silence => {
            format!(
                "anullsrc=channel_layout=mono:sample_rate={sample_rate},atrim=duration={seconds}"
            )
        }
    }
}

fn lavfi(source: &str) -> Vec<String> {
    vec![
        "-f".to_owned(),
        "lavfi".to_owned(),
        "-i".to_owned(),
        source.to_owned(),
    ]
}
