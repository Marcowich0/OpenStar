//! The `.txt` parser's body: Voices, Lines and Notes, through
//! `openstar::txt::parse`. Fixture snapshots are in `txt_fixtures.rs`.

use openstar::txt::{TxtFile, parse};
use openstar_protocol::song::{Line, LineEnd, Note, NoteKind, TxtRejection, TxtWarning, Voice};

/// A playable header block; tests append the body they exercise.
const HEAD: &str =
    "#TITLE:Placeholder Title\n#ARTIST:Placeholder Artist\n#BPM:100\n#MP3:song.mp3\n";

fn accept(body: &str) -> TxtFile {
    parse(format!("{HEAD}{body}").as_bytes(), "folder").expect("the file is accepted")
}

fn reject(body: &str) -> TxtRejection {
    parse(format!("{HEAD}{body}").as_bytes(), "folder").expect_err("the file is rejected")
}

fn note(kind: NoteKind, start: i32, length: i32, pitch: i32, text: &str, line: u32) -> Note {
    Note {
        kind,
        start,
        length,
        pitch,
        text: text.into(),
        line,
    }
}

/// The Notes of each Line of a Voice, as `(start, text)`.
fn starts_and_texts(voice: &Voice) -> Vec<Vec<(i32, &str)>> {
    voice
        .lines
        .iter()
        .map(|l| l.notes.iter().map(|n| (n.start, n.text.as_str())).collect())
        .collect()
}

#[test]
fn a_solo_body_is_one_voice_of_lines_of_notes() {
    // Lines 1–4 are the header.
    let file = accept(": 0 4 0 La\n: 4 4 2 la\n- 10\n* 12 4 -3 Lo\nE\n");
    assert_eq!(
        file.song.voices,
        vec![Voice {
            lines: vec![
                Line {
                    notes: vec![
                        note(NoteKind::Normal, 0, 4, 0, "La", 5),
                        note(NoteKind::Normal, 4, 4, 2, "la", 6),
                    ],
                    end: Some(LineEnd { beat: 10, line: 7 }),
                },
                Line {
                    notes: vec![note(NoteKind::Golden, 12, 4, -3, "Lo", 8)],
                    end: None,
                },
            ],
        }]
    );
    assert_eq!(file.song.headers.title, "Placeholder Title");
    assert_eq!(file.warnings, vec![]);
}

#[test]
fn fields_take_runs_of_spaces_or_tabs_and_the_text_keeps_its_spaces() {
    let file = accept(":\t0  4 \t 0  la \n:  4\t4\t2\t\tla\n* 8 4 1\n");
    let notes = &file.song.voices[0].lines[0].notes;
    // The text is everything after the single separator following the pitch.
    assert_eq!(notes[0].text, " la ");
    assert_eq!(notes[1].text, "\tla");
    assert_eq!((notes[1].start, notes[1].length, notes[1].pitch), (4, 4, 2));
    assert_eq!(notes[2].text, "");
}

#[test]
fn each_note_type_is_parsed() {
    let file = accept(": 0 1 0 a\n* 1 1 0 b\nR 2 1 0 c\nG 3 1 0 d\nF 4 1 0 e\n");
    let kinds: Vec<_> = file.song.voices[0].lines[0]
        .notes
        .iter()
        .map(|n| n.kind)
        .collect();
    assert_eq!(
        kinds,
        vec![
            NoteKind::Normal,
            NoteKind::Golden,
            NoteKind::Rap,
            NoteKind::GoldenRap,
            NoteKind::Freestyle
        ]
    );
}

#[test]
fn a_zero_length_note_becomes_freestyle_with_a_warning() {
    let file = accept(": 0 4 0 La\n* 4 0 2 la\n");
    let notes = &file.song.voices[0].lines[0].notes;
    assert_eq!(notes[1].kind, NoteKind::Freestyle);
    assert_eq!(notes[1].length, 0);
    assert_eq!(file.warnings, vec![TxtWarning::ZeroLengthNote { line: 6 }]);
}

#[test]
fn a_line_end_marker_ignores_any_further_number() {
    let file = accept(": 0 4 0 La\n- 6 12\n: 8 4 0 la\n");
    assert_eq!(
        file.song.voices[0].lines[0].end,
        Some(LineEnd { beat: 6, line: 6 })
    );
    assert_eq!(file.warnings, vec![]);
}

#[test]
fn a_repeated_marker_is_ignored_and_a_line_with_no_notes_is_dropped() {
    let file = accept("- 0\n: 0 4 0 La\n- 6\n-\t7\n: 8 4 0 la\n- 14\nE\n");
    let voice = &file.song.voices[0];
    assert_eq!(
        starts_and_texts(voice),
        vec![vec![(0, "La")], vec![(8, "la")]]
    );
    assert_eq!(voice.lines[0].end, Some(LineEnd { beat: 6, line: 7 }));
    assert_eq!(voice.lines[1].end, Some(LineEnd { beat: 14, line: 10 }));
    assert_eq!(file.warnings, vec![]);
}

#[test]
fn p1_and_p2_switch_voice_without_ending_a_line() {
    let file = accept("P1\n: 0 4 0 a\nP2\n: 0 4 0 b\nP1\n: 4 4 0 c\n- 8\nP2\n- 6\n: 8 4 0 d\nE\n");
    let voices = &file.song.voices;
    assert_eq!(voices.len(), 2);
    assert_eq!(starts_and_texts(&voices[0]), vec![vec![(0, "a"), (4, "c")]]);
    assert_eq!(
        starts_and_texts(&voices[1]),
        vec![vec![(0, "b")], vec![(8, "d")]]
    );
    assert_eq!(voices[0].lines[0].end, Some(LineEnd { beat: 8, line: 11 }));
    assert_eq!(voices[1].lines[0].end, Some(LineEnd { beat: 6, line: 13 }));
}

#[test]
fn notes_before_the_first_p_line_belong_to_p1_and_p_with_a_space_is_accepted() {
    let file = accept(": 0 4 0 a\nP 2\n: 0 4 0 b\nP\t1\n: 4 4 0 c\n");
    let voices = &file.song.voices;
    assert_eq!(starts_and_texts(&voices[0]), vec![vec![(0, "a"), (4, "c")]]);
    assert_eq!(starts_and_texts(&voices[1]), vec![vec![(0, "b")]]);
}

#[test]
fn a_song_without_p_lines_is_solo() {
    assert_eq!(accept(": 0 4 0 a\n").song.voices.len(), 1);
}

#[test]
fn a_p_number_other_than_1_or_2_is_a_rejection() {
    assert_eq!(
        reject(": 0 4 0 a\nP3\n: 0 4 0 b\n"),
        TxtRejection::InvalidVoice { line: 6 }
    );
    assert_eq!(
        reject("P0\n: 0 4 0 b\n"),
        TxtRejection::InvalidVoice { line: 5 }
    );
}

#[test]
fn a_duet_voice_with_no_notes_is_a_rejection() {
    assert_eq!(
        reject("P1\n: 0 4 0 a\n- 6\nP2\n- 8\nE\n"),
        TxtRejection::DuetVoiceWithoutNotes { voice: 2 }
    );
    assert_eq!(
        reject("P1\nP2\n: 0 4 0 a\nE\n"),
        TxtRejection::DuetVoiceWithoutNotes { voice: 1 }
    );
}

#[test]
fn a_song_with_no_notes_at_all_is_a_rejection() {
    assert_eq!(reject("- 4\nE\n"), TxtRejection::NoNotes);
    assert_eq!(reject("E\n"), TxtRejection::NoNotes);
    // A file that ends inside the header has no Notes.
    assert_eq!(reject(""), TxtRejection::NoNotes);
}

#[test]
fn a_note_line_whose_start_length_or_pitch_is_not_an_integer_is_a_rejection() {
    for (body, line) in [
        (": 0 4 0 a\n: x 4 0 b\n", 6),
        (": 0 4.5 0 a\n", 5),
        ("* 0 4 high a\n", 5),
        ("F 0 4\n", 5),
        ("Rap lyrics\n", 5),
    ] {
        assert_eq!(
            reject(body),
            TxtRejection::InvalidNoteLine { line },
            "{body:?}"
        );
    }
}

#[test]
fn notes_are_not_re_sorted_and_overlaps_in_one_voice_are_a_warning() {
    let file = accept(": 8 4 0 b\n: 0 4 0 a\n: 2 4 0 c\nP2\n: 2 4 0 x\n");
    assert_eq!(
        starts_and_texts(&file.song.voices[0]),
        vec![vec![(8, "b"), (0, "a"), (2, "c")]]
    );
    assert_eq!(
        file.warnings,
        vec![TxtWarning::OverlappingNotes {
            line: 7,
            earlier_line: 6
        }]
    );
}

#[test]
fn touching_notes_and_zero_length_notes_do_not_overlap() {
    let file = accept(": 0 4 0 a\n: 4 4 0 b\n: 5 0 0 c\n");
    assert_eq!(file.warnings, vec![TxtWarning::ZeroLengthNote { line: 7 }]);
}

#[test]
fn an_unknown_body_line_is_skipped_with_a_warning() {
    let file = accept(": 0 4 0 a\nB 4 300\n- 6\n- six\n#GAP:5\n: 8 4 0 b\n");
    assert_eq!(
        starts_and_texts(&file.song.voices[0]),
        vec![vec![(0, "a")], vec![(8, "b")]]
    );
    assert_eq!(
        file.warnings,
        vec![
            TxtWarning::UnknownBodyLine { line: 6 },
            TxtWarning::UnknownBodyLine { line: 8 },
            TxtWarning::UnknownBodyLine { line: 9 },
        ]
    );
}

#[test]
fn rejections_and_warnings_are_codes_with_parameters() {
    assert_eq!(
        serde_json::to_string(&TxtRejection::DuetVoiceWithoutNotes { voice: 2 }).unwrap(),
        r#"{"code":"duetVoiceWithoutNotes","voice":2}"#
    );
    assert_eq!(
        serde_json::to_string(&TxtWarning::OverlappingNotes {
            line: 9,
            earlier_line: 7
        })
        .unwrap(),
        r#"{"code":"overlappingNotes","line":9,"earlierLine":7}"#
    );
}
