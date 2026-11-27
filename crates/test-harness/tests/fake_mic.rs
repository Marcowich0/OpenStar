//! The fake microphone inputs `just e2e` and the Mic bridge tests feed in,
//! checked against the fixture Library Song they are meant to sing.

use crate::support::{decode, frequency, midi, peak, wav_channels};
use openstar_protocol::song::NoteKind;
use openstar_test_harness::fake_mic::{self, FakeMic};
use openstar_test_harness::fixture_library::{self, STEADY_TONE, read_song};

fn written() -> (tempfile::TempDir, fake_mic::FakeMicFiles) {
    let dir = tempfile::tempdir().unwrap();
    let files = fake_mic::write(dir.path()).unwrap();
    (dir, files)
}

#[test]
fn the_steady_tone_hits_every_scored_note_of_the_steady_tone_song() {
    let (_dir, files) = written();
    let (rate, channels) = decode(&files.steady_tone);
    assert_eq!(channels.len(), 1);
    let heard = midi(frequency(&channels[0], rate));
    assert!(
        (heard - heard.round()).abs() < 0.1,
        "the steady tone is between two notes: MIDI {heard:.2}"
    );
    let pitch_class = (heard.round() as i32).rem_euclid(12);

    let song = read_song(&fixture_library::source_dir().join(STEADY_TONE))
        .unwrap()
        .unwrap();
    let scored: Vec<_> = song
        .voices
        .iter()
        .flat_map(|v| v.lines.iter().flat_map(|l| l.notes.iter()))
        .filter(|n| matches!(n.kind, NoteKind::Normal | NoteKind::Golden))
        .collect();
    assert!(scored.len() >= 4, "the steady-tone Song needs scored Notes");
    for note in scored {
        assert_eq!(
            (note.pitch + 60).rem_euclid(12),
            pitch_class,
            "line {} of the steady-tone Song is not on the fake mic's pitch class",
            note.line
        );
    }
}

#[test]
fn the_steady_tone_is_the_described_frequency_and_loops_cleanly() {
    let mic = FakeMic::load().unwrap();
    let (_dir, files) = written();
    let (rate, channels) = decode(&files.steady_tone);
    assert_eq!(rate, mic.sample_rate);
    assert_eq!(
        channels[0].len() as f64,
        f64::from(mic.sample_rate) * mic.seconds
    );
    assert!((frequency(&channels[0], rate) - mic.steady_tone.hz).abs() < 0.5);
    // Whole cycles, so Chromium's loop has no click.
    assert_eq!((mic.steady_tone.hz * mic.seconds).fract(), 0.0);
}

#[test]
fn the_silence_is_digital_silence() {
    let (_dir, files) = written();
    let (_, channels) = decode(&files.silence);
    assert_eq!(channels.len(), 1);
    assert!(!channels[0].is_empty());
    assert_eq!(peak(&channels[0]), 0.0);
}

#[test]
fn the_multichannel_wav_has_the_tone_on_one_channel_and_silence_on_the_others() {
    let mic = FakeMic::load().unwrap();
    let (_dir, files) = written();
    assert_eq!(wav_channels(&files.multichannel), mic.multichannel.channels);
    let (rate, channels) = decode(&files.multichannel);
    assert_eq!(channels.len(), usize::from(mic.multichannel.channels));
    for (i, channel) in channels.iter().enumerate() {
        if i == usize::from(mic.multichannel.tone_channel) {
            assert!((frequency(channel, rate) - mic.steady_tone.hz).abs() < 0.5);
        } else {
            assert_eq!(peak(channel), 0.0, "channel {i} is not silent");
        }
    }
}

#[test]
fn the_files_have_the_described_names() {
    let mic = FakeMic::load().unwrap();
    let (dir, files) = written();
    assert_eq!(files.steady_tone, dir.path().join(&mic.steady_tone.file));
    assert_eq!(files.silence, dir.path().join(&mic.silence.file));
    assert_eq!(files.multichannel, dir.path().join(&mic.multichannel.file));
}
