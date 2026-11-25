//! Media generators: the real ffmpeg, writing only to temporary folders.

use std::path::Path;
use std::process::Command;

use openstar_test_harness::{Media, Signal};

/// What ffprobe reports about a file.
struct Probe {
    duration: f64,
    streams: Vec<serde_json::Value>,
}

fn probe(path: &Path) -> Probe {
    let output = Command::new("ffprobe")
        .args(["-v", "error", "-show_entries"])
        .arg("stream=codec_type,sample_rate,channels,width,height:format=duration")
        .args(["-of", "json"])
        .arg(path)
        .output()
        .expect("ffprobe (part of ffmpeg) runs");
    assert!(output.status.success(), "ffprobe {}", path.display());
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    Probe {
        duration: json["format"]["duration"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
        streams: json["streams"].as_array().unwrap().clone(),
    }
}

/// The 16-bit samples of a PCM WAV, one Vec per channel.
fn wav_channels(path: &Path, channels: usize) -> Vec<Vec<i16>> {
    let bytes = std::fs::read(path).unwrap();
    let data = bytes
        .windows(4)
        .position(|w| w == b"data")
        .expect("a data chunk");
    let samples: Vec<i16> = bytes[data + 8..]
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    (0..channels)
        .map(|c| samples.iter().skip(c).step_by(channels).copied().collect())
        .collect()
}

/// Frequency estimated from rising zero crossings.
fn frequency(samples: &[i16], sample_rate: u32) -> f64 {
    let crossings = samples.windows(2).filter(|w| w[0] < 0 && w[1] >= 0).count();
    crossings as f64 * f64::from(sample_rate) / samples.len() as f64
}

fn peak(samples: &[i16]) -> i32 {
    samples
        .iter()
        .map(|s| i32::from(*s).abs())
        .max()
        .unwrap_or(0)
}

#[test]
fn a_tone_has_the_asked_length_sample_rate_and_pitch() {
    let media = Media::new();
    let tone = media.tone("a440.wav", 440.0, 1.5, 48_000).unwrap();

    let probe = probe(&tone);
    assert!((probe.duration - 1.5).abs() < 0.01, "{}", probe.duration);
    assert_eq!(probe.streams[0]["sample_rate"], "48000");
    assert_eq!(probe.streams[0]["channels"], 1);
    let samples = &wav_channels(&tone, 1)[0];
    assert!((frequency(samples, 48_000) - 440.0).abs() < 2.0);
}

#[test]
fn a_sine_melody_plays_its_notes_in_order() {
    let media = Media::new();
    let melody = media
        .sine_melody(
            "melody.wav",
            &[(220.0, 0.5), (0.0, 0.25), (880.0, 0.5)],
            44_100,
        )
        .unwrap();

    let probe = probe(&melody);
    assert!((probe.duration - 1.25).abs() < 0.01, "{}", probe.duration);
    let samples = &wav_channels(&melody, 1)[0];
    let (first, rest) = samples.split_at(22_050);
    let (rest_part, last) = rest.split_at(11_025);
    assert!((frequency(first, 44_100) - 220.0).abs() < 3.0);
    assert_eq!(peak(rest_part), 0, "a 0 Hz note is a rest");
    assert!((frequency(last, 44_100) - 880.0).abs() < 3.0);
}

#[test]
fn noise_and_silence_have_the_asked_length() {
    let media = Media::new();
    let noise = media.noise("noise.wav", 0.5, 0.5, 44_100).unwrap();
    let silence = media.silence("silence.wav", 0.75, 44_100).unwrap();

    assert!((probe(&noise).duration - 0.5).abs() < 0.01);
    assert!(peak(&wav_channels(&noise, 1)[0]) > 1_000);
    assert!((probe(&silence).duration - 0.75).abs() < 0.01);
    assert_eq!(peak(&wav_channels(&silence, 1)[0]), 0);
}

#[test]
fn a_multichannel_wav_carries_the_chosen_signal_on_each_channel() {
    let media = Media::new();
    let wav = media
        .multichannel_wav(
            "four.wav",
            &[
                Signal::Tone(330.0),
                Signal::Silence,
                Signal::Noise(0.3),
                Signal::Tone(660.0),
            ],
            1.0,
            48_000,
        )
        .unwrap();

    let probe = probe(&wav);
    assert_eq!(probe.streams[0]["channels"], 4);
    assert_eq!(probe.streams[0]["sample_rate"], "48000");
    let channels = wav_channels(&wav, 4);
    assert!((frequency(&channels[0], 48_000) - 330.0).abs() < 2.0);
    assert_eq!(peak(&channels[1]), 0);
    assert!(peak(&channels[2]) > 1_000);
    assert!((frequency(&channels[3], 48_000) - 660.0).abs() < 2.0);
}

#[test]
fn a_tiny_video_has_a_video_and_an_audio_stream() {
    let media = Media::new();
    let video = media.tiny_video("clip.mp4", 1.0).unwrap();

    let probe = probe(&video);
    assert!((probe.duration - 1.0).abs() < 0.1, "{}", probe.duration);
    let kinds: Vec<&str> = probe
        .streams
        .iter()
        .map(|s| s["codec_type"].as_str().unwrap())
        .collect();
    assert!(
        kinds.contains(&"video") && kinds.contains(&"audio"),
        "{kinds:?}"
    );
    let video_stream = probe
        .streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .unwrap();
    assert_eq!(video_stream["width"], 64);
}

#[test]
fn media_is_written_only_to_a_temporary_folder() {
    let media = Media::new();
    let tone = media.tone("t.wav", 440.0, 0.1, 44_100).unwrap();
    assert!(tone.starts_with(std::env::temp_dir()), "{}", tone.display());
    assert!(!tone.starts_with(env!("CARGO_MANIFEST_DIR")));

    for name in ["../escape.wav", "/tmp/escape.wav", "sub/escape.wav", ""] {
        let error = media.tone(name, 440.0, 0.1, 44_100).unwrap_err();
        assert!(
            error.to_string().contains("plain file name"),
            "{name}: {error}"
        );
    }

    let dir = media.dir().to_path_buf();
    drop(media);
    assert!(!dir.exists(), "the folder is removed with the Media");
}

#[test]
fn without_ffmpeg_the_error_names_ffmpeg() {
    let media = Media::with_ffmpeg("/nonexistent/ffmpeg");
    let error = media.tone("t.wav", 440.0, 0.1, 44_100).unwrap_err();
    let message = error.to_string();
    assert!(message.contains("ffmpeg was not found"), "{message}");
    assert!(message.contains("install ffmpeg"), "{message}");
}
