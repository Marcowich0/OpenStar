//! Reading generated audio back, for the fixture Library and fake mic tests.

#![allow(dead_code)]

use std::path::Path;
use std::process::Command;

/// Decodes `path` with ffmpeg into its sample rate and one sample list per
/// channel (−1 to 1), keeping its rate and channels.
pub fn decode(path: &Path) -> (u32, Vec<Vec<f32>>) {
    let probe = Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "a:0"])
        .args([
            "-show_entries",
            "stream=sample_rate,channels",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .expect("running ffprobe");
    assert!(
        probe.status.success(),
        "ffprobe failed on {}",
        path.display()
    );
    let text = String::from_utf8(probe.stdout).unwrap();
    let mut fields = text.trim().split(',');
    let rate: u32 = fields.next().unwrap().parse().unwrap();
    let count: usize = fields.next().unwrap().parse().unwrap();
    let output = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
        .arg(path)
        .args(["-f", "s16le", "-acodec", "pcm_s16le", "-"])
        .output()
        .expect("running ffmpeg");
    assert!(
        output.status.success(),
        "ffmpeg failed on {}",
        path.display()
    );
    let mut channels = vec![Vec::new(); count];
    for (i, pair) in output.stdout.as_chunks::<2>().0.iter().enumerate() {
        let value = i16::from_le_bytes(*pair);
        channels[i % count].push(f32::from(value) / 32_768.0);
    }
    (rate, channels)
}

/// The channel count a WAV file's header states.
pub fn wav_channels(path: &Path) -> u16 {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[12..16], b"fmt ");
    u16::from_le_bytes([bytes[22], bytes[23]])
}

/// The frequency of a clean tone, from its rising zero crossings.
pub fn frequency(samples: &[f32], rate: u32) -> f64 {
    let mut crossings = Vec::new();
    for i in 1..samples.len() {
        let (a, b) = (f64::from(samples[i - 1]), f64::from(samples[i]));
        if a < 0.0 && b >= 0.0 {
            crossings.push((i - 1) as f64 + a / (a - b));
        }
    }
    assert!(crossings.len() > 2, "no tone found");
    let span = crossings[crossings.len() - 1] - crossings[0];
    (crossings.len() - 1) as f64 * f64::from(rate) / span
}

/// The MIDI note number of `hz`, not rounded.
pub fn midi(hz: f64) -> f64 {
    69.0 + 12.0 * (hz / 440.0).log2()
}

/// The loudest absolute sample.
pub fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0, |m, s| m.max(s.abs()))
}
