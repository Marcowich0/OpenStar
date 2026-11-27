//! The fixture Library (`fixtures/library/`) with its audio generated.
//!
//! The `.txt` files are committed; the audio never is. [`install`] copies the
//! Library into a folder and writes, for every `.txt` the Library's own parser
//! accepts, the audio file it references: a sine tone per Note at the Note's
//! pitch and time, encoded by the real ffmpeg. So the text and the audio can
//! never disagree. A Song that names a separate `#VIDEO` also gets a tiny
//! silent test-pattern video, as long as the audio from where it starts
//! (*audio position + `#VIDEOGAP`*). Server tests use [`AppFolders::with_fixture_library`];
//! `just e2e` runs `openstar-harness fixture-library <dir>`.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use anyhow::{Context, bail};
use openstar_protocol::song::{ParsedSong, TxtRejection};

use crate::AppFolders;

/// The Song whose scored Notes all share one pitch class, so the fake mic's
/// steady tone hits every one of them (see [`crate::fake_mic`]).
pub const STEADY_TONE: &str = "Placeholder Artist - Steady Tone/steady-tone.txt";
/// A Song with Notes on different pitches (also for the Pitch track job).
pub const SINE_MELODY: &str = "Placeholder Artist - Sine Melody/sine-melody.txt";
/// A duet: two Voices, sometimes singing at once.
pub const DUET: &str = "Placeholder Duo - Two Voices/duet.txt";
/// Separate audio and video files (#212): the steady-tone Song's Notes with a
/// silent video that starts 1.5 s into the audio (`#VIDEOGAP:-1.5`).
pub const SEPARATE_VIDEO: &str = "Placeholder Artist - Separate Video/separate-video.txt";
/// A `.txt` the parser rejects (`#VERSION:2.0.0`): a Library problem.
pub const REJECTED: &str = "Placeholder Artist - Rejected/rejected.txt";

/// The sample rate of the generated Song audio.
const SAMPLE_RATE: u32 = 44_100;
/// The amplitude of each Voice's tone; a duet's two Voices add up.
const AMPLITUDE: f64 = 0.3;
/// The fade at each end of a Note, so Notes start and stop without a click.
const FADE_SECONDS: f64 = 0.005;
/// Silence after the last Note.
const TAIL_SECONDS: f64 = 1.0;

/// `fixtures/library/` in this repository.
pub fn source_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/library")
}

/// Reads one `.txt` with the Library's parser.
pub fn read_song(txt: &Path) -> anyhow::Result<Result<ParsedSong, TxtRejection>> {
    let bytes = std::fs::read(txt).with_context(|| format!("reading {}", txt.display()))?;
    let folder = txt
        .parent()
        .and_then(Path::file_name)
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(openstar::txt::parse(&bytes, &folder).map(|file| file.song))
}

/// Copies the fixture Library into `dest` (created if missing) and generates
/// each playable Song's audio there, with `ffmpeg` from `PATH`.
pub fn install(dest: &Path) -> anyhow::Result<()> {
    install_with_ffmpeg(dest, Path::new("ffmpeg"))
}

/// [`install`] with the ffmpeg at `ffmpeg`.
pub fn install_with_ffmpeg(dest: &Path, ffmpeg: &Path) -> anyhow::Result<()> {
    copy_dir(&source_dir(), dest)?;
    for txt in txt_files(dest)? {
        let Ok(song) = read_song(&txt)? else {
            continue;
        };
        let Some(reference) = song.headers.audio_reference.as_deref() else {
            continue;
        };
        let folder = txt.parent().context("a .txt has a folder")?;
        let audio = folder.join(inside(reference)?);
        let seconds = write_audio(&song, &audio, ffmpeg)
            .with_context(|| format!("generating the audio of {}", txt.display()))?;
        if let Some(video) = song.headers.video.as_deref()
            && video != reference
        {
            let gap = song.headers.video_gap_seconds.unwrap_or(0.0);
            write_video(&folder.join(inside(video)?), seconds + gap, ffmpeg)
                .with_context(|| format!("generating the video of {}", txt.display()))?;
        }
    }
    Ok(())
}

impl AppFolders {
    /// New temporary folders whose songs folder holds the fixture Library,
    /// audio included. Panics when ffmpeg is missing or fails.
    pub fn with_fixture_library() -> Self {
        let folders = Self::new();
        install(folders.songs_dir()).expect("installing the fixture Library");
        folders
    }
}

/// The Song's mono samples: a sine per Note of every Voice, at the Note's
/// pitch (0 = C4 = MIDI 60) and time, silence elsewhere.
pub fn render(song: &ParsedSong, sample_rate: u32) -> Vec<f32> {
    let rate = f64::from(sample_rate);
    let notes: Vec<_> = song
        .voices
        .iter()
        .flat_map(|v| v.lines.iter().flat_map(|l| l.notes.iter()))
        .collect();
    let end = notes
        .iter()
        .map(|n| song.headers.seconds_at_beat(f64::from(n.start + n.length)))
        .fold(0.0, f64::max);
    let mut samples = vec![0.0_f64; ((end + TAIL_SECONDS) * rate).ceil() as usize];
    for note in notes {
        let start = song.headers.seconds_at_beat(f64::from(note.start)).max(0.0);
        let stop = song
            .headers
            .seconds_at_beat(f64::from(note.start + note.length));
        let hz = 440.0 * 2f64.powf(f64::from(note.pitch + 60 - 69) / 12.0);
        let first = (start * rate).round() as usize;
        let last = ((stop * rate).round() as usize).min(samples.len());
        for (i, sample) in samples.iter_mut().enumerate().take(last).skip(first) {
            let t = (i - first) as f64 / rate;
            let left = (last - i) as f64 / rate;
            let fade = (t.min(left) / FADE_SECONDS).min(1.0);
            *sample += AMPLITUDE * fade * (2.0 * std::f64::consts::PI * hz * t).sin();
        }
    }
    samples.into_iter().map(|s| s as f32).collect()
}

/// Renders `song` and encodes it with ffmpeg into `audio` (the container and
/// codec follow its extension); returns the audio's length in seconds.
fn write_audio(song: &ParsedSong, audio: &Path, ffmpeg: &Path) -> anyhow::Result<f64> {
    let samples = render(song, SAMPLE_RATE);
    let seconds = samples.len() as f64 / f64::from(SAMPLE_RATE);
    let scratch = tempfile::Builder::new()
        .prefix("openstar-fixture-audio-")
        .tempdir()?;
    let wav = scratch.path().join("song.wav");
    std::fs::write(&wav, wav_bytes(&samples, SAMPLE_RATE))?;
    if let Some(parent) = audio.parent() {
        std::fs::create_dir_all(parent)?;
    }
    run_ffmpeg(ffmpeg, [OsStr::new("-i"), wav.as_os_str()], audio)?;
    Ok(seconds)
}

/// A silent VP8 WebM test pattern (64×36, 25 fps), `seconds` long, at `video`.
fn write_video(video: &Path, seconds: f64, ffmpeg: &Path) -> anyhow::Result<()> {
    if seconds <= 0.0 {
        bail!("the video would start after the audio ends ({seconds} s long)");
    }
    if let Some(parent) = video.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let pattern = format!("testsrc=size=64x36:rate=25:duration={seconds:.3}");
    let args = [
        "-f", "lavfi", "-i", &pattern, "-an", "-c:v", "libvpx", "-b:v", "100k", "-pix_fmt",
        "yuv420p",
    ];
    run_ffmpeg(ffmpeg, args, video)
}

/// Runs ffmpeg quietly with `args` (its inputs and options), writing `output`.
fn run_ffmpeg<I, S>(ffmpeg: &Path, args: I, output: &Path) -> anyhow::Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let result = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"])
        .args(args)
        .arg(output)
        .output();
    let result = match result {
        Ok(result) => result,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => bail!(
            "ffmpeg was not found ({}): install ffmpeg to generate the fixture Library's media; \
             CI's setup installs it",
            ffmpeg.display()
        ),
        Err(error) => return Err(error).context("running ffmpeg"),
    };
    if !result.status.success() {
        bail!(
            "ffmpeg failed encoding {} ({}): {}",
            output.display(),
            result.status,
            String::from_utf8_lossy(&result.stderr).trim()
        );
    }
    Ok(())
}

/// A mono 16-bit PCM WAV.
fn wav_bytes(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = u32::try_from(samples.len() * 2).expect("a short Song");
    let mut bytes = Vec::with_capacity(44 + samples.len() * 2);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        let value = (f64::from(*sample).clamp(-1.0, 1.0) * 32_767.0).round() as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

/// `reference` as a relative path that stays inside its Song's folder.
fn inside(reference: &str) -> anyhow::Result<&Path> {
    let path = Path::new(reference);
    if !path.components().all(|c| matches!(c, Component::Normal(_))) {
        bail!("the fixture Library's audio reference {reference:?} leaves its folder");
    }
    Ok(path)
}

fn copy_dir(from: &Path, to: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(to).with_context(|| format!("creating {}", to.display()))?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)
                .with_context(|| format!("copying to {}", target.display()))?;
        }
    }
    Ok(())
}

fn txt_files(dir: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            found.extend(txt_files(&path)?);
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("txt"))
        {
            found.push(path);
        }
    }
    found.sort();
    Ok(found)
}
