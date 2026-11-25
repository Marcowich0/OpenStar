//! The `.txt` writer, through `openstar::txt::write`: the golden pairs under
//! `fixtures/writer/` (input + operations → expected output, compared byte
//! for byte, with an `insta` snapshot of the changed lines), the no-edit
//! round trip as a property, and the operations it refuses.

use std::path::{Path, PathBuf};

use openstar::txt::{NewNote, Operation, TxtFile, WriteError, parse, write};
use openstar_protocol::song::NoteKind;
use serde_json::Value;

fn writer_fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/writer")
}

fn accept(bytes: &[u8]) -> TxtFile {
    parse(bytes, "folder").expect("the file is accepted")
}

/// Reads one operation of an `operations.json`; see `fixtures/writer/README.md`.
fn operation(value: &Value) -> Operation {
    let int = |key: &str| {
        let n = value[key]
            .as_i64()
            .unwrap_or_else(|| panic!("{key} in {value}"));
        i32::try_from(n).unwrap()
    };
    let line = || u32::try_from(int("line")).unwrap();
    let float = |key: &str| {
        value[key]
            .as_f64()
            .unwrap_or_else(|| panic!("{key} in {value}"))
    };
    let text = || value["text"].as_str().unwrap().to_owned();
    match value["op"].as_str().unwrap() {
        "setNoteStart" => Operation::SetNoteStart {
            line: line(),
            start: int("start"),
        },
        "setNoteLength" => Operation::SetNoteLength {
            line: line(),
            length: int("length"),
        },
        "setNotePitch" => Operation::SetNotePitch {
            line: line(),
            pitch: int("pitch"),
        },
        "setNoteText" => Operation::SetNoteText {
            line: line(),
            text: text(),
        },
        "insertNote" => Operation::InsertNote {
            after: u32::try_from(int("after")).unwrap(),
            note: NewNote {
                kind: match value["kind"].as_str().unwrap() {
                    "normal" => NoteKind::Normal,
                    "golden" => NoteKind::Golden,
                    "rap" => NoteKind::Rap,
                    "goldenRap" => NoteKind::GoldenRap,
                    "freestyle" => NoteKind::Freestyle,
                    other => panic!("unknown kind {other}"),
                },
                start: int("start"),
                length: int("length"),
                pitch: int("pitch"),
                text: text(),
            },
        },
        "deleteNote" => Operation::DeleteNote { line: line() },
        "setGap" => Operation::SetGap {
            seconds: float("seconds"),
        },
        "setBpm" => Operation::SetBpm {
            beats_per_minute: float("beatsPerMinute"),
        },
        "setVideoGap" => Operation::SetVideoGap {
            seconds: float("seconds"),
        },
        "setLineEnd" => Operation::SetLineEnd {
            line: line(),
            beat: int("beat"),
        },
        other => panic!("unknown operation {other}"),
    }
}

#[test]
fn writer_golden_pairs_produce_their_expected_bytes() {
    let root = writer_fixtures();
    let mut cases: Vec<PathBuf> = std::fs::read_dir(&root)
        .expect("fixtures/writer is readable")
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_dir())
        .collect();
    cases.sort();
    assert!(
        !cases.is_empty(),
        "no golden pairs under {}",
        root.display()
    );

    for case in cases {
        let name = case.file_name().unwrap().to_string_lossy().into_owned();
        let input = std::fs::read(case.join("input.txt")).unwrap();
        let expected = std::fs::read(case.join("expected.txt")).unwrap();
        let operations: Vec<Operation> =
            serde_json::from_slice::<Value>(&std::fs::read(case.join("operations.json")).unwrap())
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(operation)
                .collect();

        let file = parse(&input, &name).unwrap_or_else(|e| panic!("{name}: input {e:?}"));
        let written = write(&file, &operations).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert!(
            written.bytes == expected,
            "{name}: written bytes differ\n--- written\n{}\n--- expected\n{}",
            written.bytes.escape_ascii(),
            expected.escape_ascii()
        );
        // The expected file must itself be a file OpenStar reads.
        parse(&expected, &name).unwrap_or_else(|e| panic!("{name}: expected {e:?}"));

        insta::with_settings!({
            snapshot_suffix => name.clone(),
            description => name.as_str(),
            omit_expression => true,
            prepend_module_to_snapshot => false,
        }, {
            insta::assert_debug_snapshot!("writer", (written.encoding, &written.changed));
        });
    }
}

/// Line 5 is a Note, line 6 a Line end marker, line 7 a repeated marker the
/// parser ignores, line 8 a Note.
const SONG: &[u8] =
    b"#TITLE:Title\n#ARTIST:Artist\n#MP3:audio.mp3\n#BPM:300\n: 0 4 0 la\n- 6\n- 7\n: 8 4 0 la\nE\n";

fn refuse(operations: &[Operation]) -> WriteError {
    write(&accept(SONG), operations).expect_err("the operations are refused")
}

#[test]
fn operations_on_lines_that_are_not_notes_are_refused() {
    let set = |line| Operation::SetNoteStart { line, start: 1 };
    assert_eq!(refuse(&[set(4)]), WriteError::NotANote { line: 4 });
    assert_eq!(refuse(&[set(6)]), WriteError::NotANote { line: 6 });
    assert_eq!(refuse(&[set(99)]), WriteError::NoSuchLine { line: 99 });
    assert_eq!(
        refuse(&[Operation::DeleteNote { line: 1 }]),
        WriteError::NotANote { line: 1 }
    );
}

#[test]
fn only_a_line_end_marker_that_closes_a_line_can_be_set() {
    let set = |line| Operation::SetLineEnd { line, beat: 5 };
    assert_eq!(refuse(&[set(5)]), WriteError::NotALineEnd { line: 5 });
    assert_eq!(refuse(&[set(7)]), WriteError::NotALineEnd { line: 7 });
    assert_eq!(refuse(&[set(0)]), WriteError::NoSuchLine { line: 0 });
}

#[test]
fn a_deleted_note_cannot_be_edited_or_deleted_again() {
    let delete = Operation::DeleteNote { line: 5 };
    assert_eq!(
        refuse(&[
            delete.clone(),
            Operation::SetNoteLength { line: 5, length: 2 }
        ]),
        WriteError::NoteDeleted { line: 5 }
    );
    assert_eq!(
        refuse(&[delete.clone(), delete]),
        WriteError::NoteDeleted { line: 5 }
    );
}

#[test]
fn a_lyric_with_a_line_break_is_refused() {
    assert_eq!(
        refuse(&[Operation::SetNoteText {
            line: 5,
            text: "la\nla".into()
        }]),
        WriteError::LineBreakInText { line: 5 }
    );
    let note = NewNote {
        kind: NoteKind::Normal,
        start: 4,
        length: 2,
        pitch: 0,
        text: "la\r".into(),
    };
    assert_eq!(
        refuse(&[Operation::InsertNote { after: 5, note }]),
        WriteError::LineBreakInText { line: 5 }
    );
}

#[test]
fn header_values_must_be_finite_and_a_bpm_the_parser_accepts() {
    for operation in [
        Operation::SetGap { seconds: f64::NAN },
        Operation::SetVideoGap {
            seconds: f64::INFINITY,
        },
        Operation::SetBpm {
            beats_per_minute: 0.5,
        },
    ] {
        assert_eq!(refuse(&[operation]), WriteError::InvalidNumber);
    }
}

#[test]
fn operations_that_change_nothing_return_the_input() {
    let file = accept(SONG);
    let written = write(
        &file,
        &[
            Operation::SetGap { seconds: 0.0 },
            Operation::SetVideoGap { seconds: 0.0 },
            Operation::SetBpm {
                beats_per_minute: 1200.0,
            },
            Operation::SetNoteStart { line: 5, start: 0 },
            Operation::SetNoteText {
                line: 8,
                text: "la".into(),
            },
            Operation::SetLineEnd { line: 6, beat: 6 },
        ],
    )
    .unwrap();
    assert_eq!(written.bytes, SONG);
    assert!(written.changed.is_empty());
}

#[test]
fn the_last_value_set_for_a_header_wins() {
    let written = write(
        &accept(SONG),
        &[
            Operation::SetGap { seconds: 1.0 },
            Operation::SetGap { seconds: 2.0 },
        ],
    )
    .unwrap();
    assert_eq!(written.changed.len(), 1);
    assert_eq!(written.changed[0].new.as_deref(), Some("#GAP:2000"));
}

mod round_trip {
    use proptest::prelude::*;

    use super::*;

    fn ending() -> impl Strategy<Value = &'static [u8]> {
        prop_oneof![Just(&b"\n"[..]), Just(&b"\r\n"[..]), Just(&b"\r"[..])]
    }

    fn separator() -> impl Strategy<Value = Vec<u8>> {
        prop::collection::vec(prop_oneof![Just(b' '), Just(b'\t')], 1..3)
    }

    /// Lyric bytes: ASCII, spaces, and bytes above 0x7F (which push the file
    /// into CP1252/CP1250 detection when they are not valid UTF-8).
    fn lyric() -> impl Strategy<Value = Vec<u8>> {
        prop::collection::vec(
            prop_oneof![
                Just(b' '),
                b'a'..=b'z',
                0x80u8..=0xFF,
                Just(0xC3u8),
                Just(0xA9u8),
            ],
            0..6,
        )
    }

    fn header() -> impl Strategy<Value = Vec<u8>> {
        prop_oneof![
            (1u32..400, 0u32..100, any::<bool>()).prop_map(|(whole, frac, comma)| {
                format!("#GAP:{whole}{}{frac}", if comma { ',' } else { '.' }).into_bytes()
            }),
            Just(b"#GENRE:Pop".to_vec()),
            Just(b"#CUSTOM-THING:x".to_vec()),
            Just(b"#NOCOLON".to_vec()),
            Just(b"#ENCODING:CP1252".to_vec()),
            Just(b"#VIDEOGAP:-0,5".to_vec()),
            Just(b"  ".to_vec()),
        ]
    }

    fn body_line() -> impl Strategy<Value = Vec<u8>> {
        prop_oneof![
            (
                prop_oneof![Just(b':'), Just(b'*'), Just(b'F'), Just(b'R'), Just(b'G')],
                separator(),
                -5i32..200,
                separator(),
                0i32..8,
                separator(),
                -12i32..12,
                prop::option::of((prop_oneof![Just(b' '), Just(b'\t')], lyric())),
            )
                .prop_map(|(kind, s1, start, s2, length, s3, pitch, text)| {
                    let mut line = vec![kind];
                    line.extend(s1);
                    line.extend(start.to_string().bytes());
                    line.extend(s2);
                    line.extend(length.to_string().bytes());
                    line.extend(s3);
                    line.extend(pitch.to_string().bytes());
                    if let Some((sep, text)) = text {
                        line.push(sep);
                        line.extend(text);
                    }
                    line
                }),
            (separator(), 0i32..300).prop_map(|(s, beat)| [
                b"-".to_vec(),
                s,
                beat.to_string().into_bytes()
            ]
            .concat()),
            Just(b"".to_vec()),
            Just(b"B 0 120".to_vec()),
        ]
    }

    /// A playable file with random headers, body lines, line endings,
    /// separators and encodings, optionally a BOM, optionally an `E`
    /// followed by junk, optionally without a final line break.
    fn file() -> impl Strategy<Value = Vec<u8>> {
        (
            any::<bool>(),
            prop::collection::vec((header(), ending()), 0..5),
            (1u32..400, any::<bool>(), ending()),
            prop::collection::vec((body_line(), ending()), 0..12),
            prop::option::of((ending(), lyric())),
            any::<bool>(),
        )
            .prop_map(
                |(bom, headers, (bpm, comma, bpm_end), body, end, final_break)| {
                    let mut out = Vec::new();
                    if bom {
                        out.extend_from_slice(b"\xEF\xBB\xBF");
                    }
                    out.extend_from_slice(b"#TITLE:Placeholder\n#ARTIST:Placeholder\n");
                    let sep = if comma { ',' } else { '.' };
                    out.extend(format!("#BPM:{bpm}{sep}5").bytes());
                    out.extend_from_slice(bpm_end);
                    for (h, e) in headers {
                        out.extend(h);
                        out.extend_from_slice(e);
                    }
                    out.extend_from_slice(b": 0 4 0 la\n");
                    for (l, e) in body {
                        out.extend(l);
                        out.extend_from_slice(e);
                    }
                    if let Some((e, junk)) = end {
                        out.extend_from_slice(b"E");
                        out.extend_from_slice(e);
                        out.extend(junk);
                    }
                    if !final_break {
                        while matches!(out.last(), Some(b'\n' | b'\r')) {
                            out.pop();
                        }
                    }
                    out
                },
            )
    }

    proptest! {
        #[test]
        fn writing_with_no_operations_returns_the_input(bytes in file()) {
            // Random bytes can make a file the parser rejects (an
            // unparsable Note); only accepted files can be written.
            if let Ok(file) = parse(&bytes, "folder") {
                let written = write(&file, &[]).unwrap();
                prop_assert_eq!(&written.bytes, &bytes);
                prop_assert!(written.changed.is_empty());
                prop_assert_eq!(written.encoding, file.encoding);
            }
        }
    }
}
