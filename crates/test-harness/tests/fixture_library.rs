//! The fixture Library: its Songs get audio generated from their own Notes.

use std::path::Path;

use crate::support::{decode, frequency, midi};
use openstar_protocol::song::{Note, ParsedSong};
use openstar_test_harness::fixture_library::{
    self, DUET, REJECTED, SEPARATE_VIDEO, SINE_MELODY, STEADY_TONE, read_song,
};

const PLAYABLE: [&str; 4] = [STEADY_TONE, SINE_MELODY, DUET, SEPARATE_VIDEO];

fn installed() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fixture_library::install(dir.path()).unwrap();
    dir
}

fn audio_path(library: &Path, txt: &str, song: &ParsedSong) -> std::path::PathBuf {
    let folder = Path::new(txt).parent().unwrap();
    library
        .join(folder)
        .join(song.headers.audio_reference.as_deref().unwrap())
}

/// Every Note of `song` that no Note of another Voice overlaps, with its
/// Voice's index.
fn solo_notes(song: &ParsedSong) -> Vec<&Note> {
    let notes: Vec<(usize, &Note)> = song
        .voices
        .iter()
        .enumerate()
        .flat_map(|(v, voice)| {
            voice
                .lines
                .iter()
                .flat_map(move |l| l.notes.iter().map(move |n| (v, n)))
        })
        .collect();
    notes
        .iter()
        .filter(|(v, n)| {
            !notes.iter().any(|(w, m)| {
                w != v && m.start < n.start + n.length && n.start < m.start + m.length
            })
        })
        .map(|(_, n)| *n)
        .collect()
}

#[test]
fn the_fixture_library_holds_four_songs_and_a_rejected_file() {
    let dir = fixture_library::source_dir();
    for txt in PLAYABLE {
        let song = read_song(&dir.join(txt)).unwrap();
        assert!(song.is_ok(), "{txt} should parse: {song:?}");
    }
    assert_eq!(read_song(&dir.join(DUET)).unwrap().unwrap().voices.len(), 2);
    assert!(read_song(&dir.join(REJECTED)).unwrap().is_err());
}

#[test]
fn every_playable_song_gets_audio_that_sings_its_own_notes() {
    let library = installed();
    for txt in PLAYABLE {
        let song = read_song(&library.path().join(txt)).unwrap().unwrap();
        let audio = audio_path(library.path(), txt, &song);
        let (rate, channels) = decode(&audio);
        let samples = &channels[0];
        let last_end = song
            .voices
            .iter()
            .flat_map(|v| v.lines.iter().flat_map(|l| l.notes.iter()))
            .map(|n| song.headers.seconds_at_beat(f64::from(n.start + n.length)))
            .fold(0.0, f64::max);
        assert!(
            samples.len() as f64 / f64::from(rate) > last_end,
            "{txt}: the audio ends before its last Note"
        );
        for note in solo_notes(&song) {
            let start = song.headers.seconds_at_beat(f64::from(note.start));
            let end = song
                .headers
                .seconds_at_beat(f64::from(note.start + note.length));
            // The middle of the Note, clear of its fades.
            let from = ((start + (end - start) * 0.2) * f64::from(rate)) as usize;
            let to = ((end - (end - start) * 0.2) * f64::from(rate)) as usize;
            let heard = midi(frequency(&samples[from..to], rate));
            let expected = f64::from(note.pitch + 60);
            assert!(
                (heard - expected).abs() < 0.3,
                "{txt}: line {} should sound MIDI {expected}, sounds {heard:.2}",
                note.line
            );
        }
        // Silence before the first Note (the GAP).
        let gap = (song.headers.gap_seconds * 0.5 * f64::from(rate)) as usize;
        assert!(
            samples[..gap].iter().all(|s| s.abs() < 0.01),
            "{txt}: GAP is not silent"
        );
    }
}

/// The streams (`codec_type`, `codec_name`) and duration ffprobe reports.
fn probe(path: &Path) -> (Vec<(String, String)>, f64) {
    let output = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_entries"])
        .arg("stream=codec_type,codec_name:format=duration")
        .args(["-of", "json"])
        .arg(path)
        .output()
        .expect("ffprobe (part of ffmpeg) runs");
    assert!(output.status.success(), "ffprobe {}", path.display());
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let streams = json["streams"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["codec_type"].as_str().unwrap().to_owned(),
                s["codec_name"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let duration = json["format"]["duration"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    (streams, duration)
}

#[test]
fn a_song_with_a_separate_video_gets_a_silent_video_as_long_as_it_follows_the_audio() {
    let library = installed();
    let song = read_song(&library.path().join(SEPARATE_VIDEO))
        .unwrap()
        .unwrap();
    let folder = library
        .path()
        .join(Path::new(SEPARATE_VIDEO).parent().unwrap());
    let gap = song.headers.video_gap_seconds.unwrap();
    assert!(
        gap < 0.0,
        "the video starts after the audio, behind the background"
    );
    let (audio_streams, audio_seconds) = probe(&audio_path(library.path(), SEPARATE_VIDEO, &song));
    assert_eq!(audio_streams.len(), 1);
    let (streams, video_seconds) = probe(&folder.join(song.headers.video.as_deref().unwrap()));
    // One VP8 stream and no sound: the Stage plays it natively, and muted.
    assert_eq!(streams, [("video".to_owned(), "vp8".to_owned())]);
    // It covers the audio from where it starts (audio position + #VIDEOGAP).
    assert!(
        (video_seconds - (audio_seconds + gap)).abs() < 0.2,
        "video {video_seconds} s, audio {audio_seconds} s, #VIDEOGAP {gap} s"
    );
}

#[test]
fn the_rejected_file_gets_no_audio() {
    let library = installed();
    let folder = library.path().join(Path::new(REJECTED).parent().unwrap());
    let files: Vec<String> = std::fs::read_dir(folder)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(files, ["rejected.txt"]);
}

#[test]
fn installing_copies_every_txt_unchanged() {
    let library = installed();
    for txt in PLAYABLE.iter().chain([&REJECTED]) {
        assert_eq!(
            std::fs::read(library.path().join(txt)).unwrap(),
            std::fs::read(fixture_library::source_dir().join(txt)).unwrap(),
        );
    }
}
