//! The Note fingerprint: computed from the parsed Song over `#GAP`, `#BPM`
//! and every Voice's Lines and Notes, never from the file's bytes.

use openstar::scores::{note_fingerprint, note_snapshot};
use openstar_protocol::scoring::NoteFingerprint;

/// A solo Song whose lyric holds a non-ASCII letter, so its encoding shows.
const SONG: &str = "#ARTIST:Placeholder Artist\n#TITLE:Placeholder Title\n#MP3:song.mp3\n\
#BPM:200\n#GAP:1500\n: 0 4 0 Caf\u{e9}\n* 4 2 2  la\n- 8\nR 10 4 -3 lo\nF 14 2 0 ~\nE\n";

fn fingerprint(bytes: &[u8]) -> NoteFingerprint {
    let file = openstar::txt::parse(bytes, "Placeholder Artist - Placeholder Title").unwrap();
    note_fingerprint(&file.song)
}

fn crlf(text: &str) -> String {
    text.replace('\n', "\r\n")
}

/// `text` encoded as CP1252 (every character here fits).
fn cp1252(text: &str) -> Vec<u8> {
    text.chars()
        .map(|c| u8::try_from(u32::from(c)).unwrap())
        .collect()
}

#[test]
fn a_fingerprint_is_sixty_four_lowercase_hex_digits() {
    let NoteFingerprint(hex) = fingerprint(SONG.as_bytes());
    assert_eq!(hex.len(), 64);
    assert!(hex.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
}

#[test]
fn encoding_line_endings_and_other_headers_do_not_change_it() {
    let original = fingerprint(SONG.as_bytes());
    assert_eq!(fingerprint(crlf(SONG).as_bytes()), original, "CRLF");
    assert_eq!(fingerprint(&cp1252(SONG)), original, "CP1252");
    let mut bom = b"\xEF\xBB\xBF".to_vec();
    bom.extend_from_slice(SONG.as_bytes());
    assert_eq!(fingerprint(&bom), original, "UTF-8 with a BOM");
    let other_headers = SONG.replace("#MP3:song.mp3\n", "#MP3:other.mp3\n#YEAR:1999\n");
    assert_eq!(
        fingerprint(other_headers.as_bytes()),
        original,
        "headers other than #GAP and #BPM"
    );
    let blank_lines = SONG.replace("- 8\n", "\n- 8\n\n");
    assert_eq!(fingerprint(blank_lines.as_bytes()), original, "blank lines");
}

#[test]
fn any_change_to_timing_or_notes_changes_it() {
    let original = fingerprint(SONG.as_bytes());
    let changes = [
        ("#GAP:1500", "#GAP:1510"),
        ("#BPM:200", "#BPM:201"),
        (": 0 4 0", ": 1 4 0"),
        (": 0 4 0", ": 0 3 0"),
        (": 0 4 0", ": 0 4 1"),
        (": 0 4 0", "* 0 4 0"),
        ("Caf\u{e9}", "Cafe"),
        ("  la", " la"),
        ("- 8", "- 9"),
    ];
    for (from, to) in changes {
        let changed = SONG.replace(from, to);
        assert_ne!(
            fingerprint(changed.as_bytes()),
            original,
            "changing {from:?} to {to:?}"
        );
    }
}

#[test]
fn a_duet_fingerprints_each_voice() {
    let duet = "#ARTIST:A\n#TITLE:T\n#MP3:song.mp3\n#BPM:200\nP1\n: 0 4 0 La\nP2\n: 4 4 2 lo\nE\n";
    let swapped =
        "#ARTIST:A\n#TITLE:T\n#MP3:song.mp3\n#BPM:200\nP1\n: 4 4 2 lo\nP2\n: 0 4 0 La\nE\n";
    assert_ne!(
        fingerprint(duet.as_bytes()),
        fingerprint(swapped.as_bytes())
    );
}

#[test]
fn the_snapshot_holds_the_notes_the_fingerprint_covers() {
    let file = openstar::txt::parse(SONG.as_bytes(), "x").unwrap();
    let snapshot = note_snapshot(&file.song);
    assert_eq!(
        serde_json::to_value(&snapshot).unwrap(),
        serde_json::json!({
            "gapSeconds": 1.5,
            "beatsPerMinute": 800.0,
            "voices": [{ "lines": [
                { "notes": [
                    { "kind": "normal", "start": 0, "length": 4, "pitch": 0, "text": "Caf\u{e9}" },
                    { "kind": "golden", "start": 4, "length": 2, "pitch": 2, "text": " la" },
                ], "end": 8 },
                { "notes": [
                    { "kind": "rap", "start": 10, "length": 4, "pitch": -3, "text": "lo" },
                    { "kind": "freestyle", "start": 14, "length": 2, "pitch": 0, "text": "~" },
                ], "end": null },
            ]}],
        })
    );
}
