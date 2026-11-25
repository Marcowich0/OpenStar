//! The `.txt` parser's lines and headers, through `openstar::txt::parse`.
//! Fixture snapshots are in `txt_fixtures.rs`.

use openstar::txt::{LineEnding, LineKind, TxtFile, parse};
use openstar_protocol::song::{FormatGeneration, TxtRejection, TxtWarning, UnknownHeader};

/// A playable header block; tests append or prepend what they exercise.
const BASE: &str =
    "#TITLE:Placeholder Title\n#ARTIST:Placeholder Artist\n#BPM:100\n#MP3:song.mp3\n";
const BODY: &str = ": 0 4 0 La\n- 6\n: 8 4 2 la\nE\n";

fn accept(text: &str) -> TxtFile {
    parse(text.as_bytes(), "folder").expect("the file is accepted")
}

fn reject(text: &str) -> TxtRejection {
    parse(text.as_bytes(), "folder").expect_err("the file is rejected")
}

fn kinds(file: &TxtFile) -> Vec<(String, LineKind)> {
    file.lines
        .iter()
        .map(|l| (String::from_utf8_lossy(&l.bytes).into_owned(), l.kind))
        .collect()
}

fn body_texts(file: &TxtFile) -> Vec<String> {
    file.body()
        .map(|l| String::from_utf8_lossy(&l.bytes).into_owned())
        .collect()
}

#[test]
fn mixed_line_endings_are_remembered_per_line() {
    let file = parse(
        b"#TITLE:T\r\n#ARTIST:A\r#BPM:100\n: 0 4 0 La\r\nE",
        "folder",
    )
    .unwrap();
    let lines: Vec<_> = file
        .lines
        .iter()
        .map(|l| {
            (
                String::from_utf8_lossy(&l.bytes).into_owned(),
                l.ending,
                l.kind,
                l.number,
            )
        })
        .collect();
    assert_eq!(
        lines,
        vec![
            ("#TITLE:T".into(), LineEnding::CrLf, LineKind::Header, 1),
            ("#ARTIST:A".into(), LineEnding::Cr, LineKind::Header, 2),
            ("#BPM:100".into(), LineEnding::Lf, LineKind::Header, 3),
            (": 0 4 0 La".into(), LineEnding::CrLf, LineKind::Body, 4),
            ("E".into(), LineEnding::None, LineKind::End, 5),
        ]
    );
}

#[test]
fn the_line_model_gives_back_the_file_byte_for_byte() {
    let input = b"\r\n#TITLE:T\r\n#ARTIST:A\r#BPM:1,5\n\n: 0 4 0  La \r\n \t\nE\r\nafter\n\n";
    let file = parse(input, "folder").unwrap();
    let mut out = Vec::new();
    for line in &file.lines {
        out.extend_from_slice(&line.bytes);
        out.extend_from_slice(line.ending.as_bytes());
    }
    assert_eq!(out, input);
}

#[test]
fn blank_lines_are_skipped_everywhere_including_the_first_line() {
    let file = accept(&format!(
        "\n   \n{BASE}\t\n#GAP:500\n: 0 4 0 La\n\n  \n: 8 4 2 la\nE\n"
    ));
    assert_eq!(file.song.headers.gap_seconds, 0.5);
    assert_eq!(body_texts(&file), vec![": 0 4 0 La", ": 8 4 2 la"]);
    assert_eq!(kinds(&file)[0].1, LineKind::Blank);
    assert_eq!(kinds(&file)[1].1, LineKind::Blank);
}

#[test]
fn the_header_ends_at_the_first_non_hash_line() {
    let file = accept(&format!("{BASE}: 0 4 0 La\n#GAP:500\n: 8 4 2 la\nE\n"));
    assert_eq!(file.song.headers.gap_seconds, 0.0);
    assert_eq!(
        body_texts(&file),
        vec![": 0 4 0 La", "#GAP:500", ": 8 4 2 la"]
    );
}

#[test]
fn everything_after_e_is_ignored() {
    let file = accept(&format!("{BASE}: 0 4 0 La\nE\n: 8 4 2 la\n#GAP:1\n"));
    assert_eq!(body_texts(&file), vec![": 0 4 0 La"]);
    let after: Vec<_> = kinds(&file).into_iter().skip(5).map(|(_, k)| k).collect();
    assert_eq!(
        after,
        vec![LineKind::End, LineKind::AfterEnd, LineKind::AfterEnd]
    );
}

#[test]
fn a_missing_e_ends_the_body_at_the_end_of_the_file() {
    let file = accept(&format!("{BASE}: 0 4 0 La\n: 8 4 2 la"));
    assert_eq!(body_texts(&file), vec![": 0 4 0 La", ": 8 4 2 la"]);
    assert!(file.lines.iter().all(|l| l.kind != LineKind::End));
}

#[test]
fn a_value_runs_from_the_first_colon_to_the_end_and_is_trimmed() {
    let file = accept(&format!(
        "#TITLE:  Part 1: The Beginning  \n#ARTIST:A\n#BPM:100\n#VIDEO: v.mp4 \n{BODY}"
    ));
    assert_eq!(file.song.headers.title, "Part 1: The Beginning");
    assert_eq!(file.song.headers.video.as_deref(), Some("v.mp4"));
}

#[test]
fn keys_compare_case_insensitively_and_are_trimmed() {
    let file = accept(&format!(
        "#title:T\n# Artist :A\n#bPm:100\n#Gap:250\n{BODY}"
    ));
    assert_eq!(file.song.headers.title, "T");
    assert_eq!(file.song.headers.artist, "A");
    assert_eq!(file.song.headers.gap_seconds, 0.25);
}

#[test]
fn an_empty_value_is_the_same_as_an_absent_header() {
    let file = accept(&format!("{BASE}#GAP:   \n#VIDEO:\n{BODY}"));
    assert_eq!(file.song.headers.gap_seconds, 0.0);
    assert_eq!(file.song.headers.video, None);
    assert!(file.warnings.is_empty());

    assert_eq!(
        reject(&format!("#TITLE:T\n#ARTIST:\n#BPM:100\n{BODY}")),
        TxtRejection::MissingArtist
    );
    assert_eq!(
        reject(&format!("#TITLE:T\n#ARTIST:A\n#BPM:\n{BODY}")),
        TxtRejection::MissingBpm
    );
}

#[test]
fn lines_without_a_colon_and_unknown_keys_are_kept_as_unknown_headers() {
    let file = accept(&format!(
        "#COMMENT\n{BASE}#AUTHOR:Someone:else\n#Custom:\n{BODY}"
    ));
    assert_eq!(
        file.song.headers.unknown_headers,
        vec![
            UnknownHeader {
                line: 1,
                key: "COMMENT".into(),
                value: None
            },
            UnknownHeader {
                line: 6,
                key: "AUTHOR".into(),
                value: Some("Someone:else".into())
            },
            UnknownHeader {
                line: 7,
                key: "Custom".into(),
                value: Some(String::new())
            },
        ]
    );
    assert_eq!(kinds(&file)[0].1, LineKind::Header);
}

#[test]
fn a_repeated_header_keeps_the_last_value_with_a_warning() {
    let file = accept(&format!("{BASE}#GAP:100\n#gap:200\n{BODY}"));
    assert_eq!(file.song.headers.gap_seconds, 0.2);
    assert_eq!(
        file.warnings,
        vec![TxtWarning::DuplicateHeader {
            line: 6,
            header: "GAP".into()
        }]
    );
}

#[test]
fn repeated_list_headers_are_joined_and_split_for_filtering() {
    let file = accept(&format!(
        "{BASE}#GENRE:Pop, Rock\n#GENRE:Jazz\n#LANGUAGE:English\n#EDITION:One,,Two \n#CREATOR:X\n#CREATOR:Y\n{BODY}"
    ));
    let h = &file.song.headers;
    assert_eq!(h.genre.as_deref(), Some("Pop, Rock, Jazz"));
    assert_eq!(h.genres, vec!["Pop", "Rock", "Jazz"]);
    assert_eq!(h.languages, vec!["English"]);
    assert_eq!(h.editions, vec!["One", "Two"]);
    assert_eq!(h.creator.as_deref(), Some("X, Y"));
    assert_eq!(h.creators, vec!["X", "Y"]);
    assert!(file.warnings.is_empty());
}

#[test]
fn decimal_headers_accept_a_comma_or_a_point() {
    let file = accept(&format!(
        "#TITLE:T\n#ARTIST:A\n#BPM:217,4\n#GAP:3650,5\n#START:12.5\n#VIDEOGAP:-1,25\n#PREVIEWSTART:30,75\n{BODY}"
    ));
    let h = &file.song.headers;
    assert!((h.beats_per_minute - 869.6).abs() < 1e-9);
    assert!((h.gap_seconds - 3.6505).abs() < 1e-9);
    assert_eq!(h.start_seconds, Some(12.5));
    assert_eq!(h.video_gap_seconds, Some(-1.25));
    assert_eq!(h.preview_start_seconds, Some(30.75));
}

#[test]
fn an_unparsable_optional_number_is_absent_with_a_warning() {
    let file = accept(&format!(
        "{BASE}#GAP:soon\n#START:1.2.3\n#END:12000.5\n#YEAR:nineties\n#MEDLEYSTARTBEAT:x\n{BODY}"
    ));
    let h = &file.song.headers;
    assert_eq!(h.gap_seconds, 0.0);
    assert_eq!(h.start_seconds, None);
    assert_eq!(h.end_seconds, None);
    assert_eq!(h.year, None);
    assert_eq!(h.medley_start_beat, None);
    let warned: Vec<_> = file
        .warnings
        .iter()
        .map(|w| match w {
            TxtWarning::InvalidNumber { line, header } => (*line, header.as_str()),
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(
        warned,
        vec![
            (5, "GAP"),
            (6, "START"),
            (7, "END"),
            (8, "YEAR"),
            (9, "MEDLEYSTARTBEAT")
        ]
    );
}

#[test]
fn units_are_normalised_to_seconds_and_real_beats() {
    let file = accept(&format!(
        "#TITLE:T\n#ARTIST:A\n#BPM:150\n#GAP:2000\n#START:5\n#END:185000\n#VIDEOGAP:0.5\n#PREVIEWSTART:42\n#MEDLEYSTARTBEAT:120\n#MEDLEYENDBEAT:480\n#YEAR:1999\n{BODY}"
    ));
    let h = &file.song.headers;
    assert_eq!(h.beats_per_minute, 600.0);
    assert_eq!(h.gap_seconds, 2.0);
    assert_eq!(h.start_seconds, Some(5.0));
    assert_eq!(h.end_seconds, Some(185.0));
    assert_eq!(h.video_gap_seconds, Some(0.5));
    assert_eq!(h.preview_start_seconds, Some(42.0));
    assert_eq!(h.medley_start_beat, Some(120));
    assert_eq!(h.medley_end_beat, Some(480));
    assert_eq!(h.year, Some(1999));
    // Beat b falls at GAP / 1000 + b × 60 / (BPM × 4): 2 + 300 × 60 / 600 = 32 s.
    assert_eq!(h.seconds_at_beat(300.0), 32.0);
    assert_eq!(h.seconds_at_beat(0.0), 2.0);
}

#[test]
fn bpm_is_required_and_at_least_one_real_beat_per_minute() {
    assert_eq!(
        reject(&format!("#TITLE:T\n#ARTIST:A\n{BODY}")),
        TxtRejection::MissingBpm
    );
    assert_eq!(
        reject(&format!("#TITLE:T\n#ARTIST:A\n#BPM:fast\n{BODY}")),
        TxtRejection::InvalidBpm { line: 3 }
    );
    assert_eq!(
        reject(&format!("#TITLE:T\n#ARTIST:A\n#BPM:0,2\n{BODY}")),
        TxtRejection::InvalidBpm { line: 3 }
    );
    assert_eq!(
        accept(&format!("#TITLE:T\n#ARTIST:A\n#BPM:0.25\n{BODY}"))
            .song
            .headers
            .beats_per_minute,
        1.0
    );
}

#[test]
fn p1_and_p2_win_over_the_duet_singer_aliases() {
    let file = accept(&format!(
        "{BASE}#DUETSINGERP1:Old One\n#DUETSINGERP2:Old Two\n#P2:New Two\n{BODY}"
    ));
    assert_eq!(file.song.headers.p1.as_deref(), Some("Old One"));
    assert_eq!(file.song.headers.p2.as_deref(), Some("New Two"));
}

#[test]
fn the_audio_reference_follows_the_generation() {
    let both = "#MP3:old.mp3\n#AUDIO:new.m4a\n";
    let v1 = accept(&format!(
        "#VERSION:1.0.0\n#TITLE:T\n#ARTIST:A\n#BPM:100\n{both}{BODY}"
    ));
    assert_eq!(v1.song.headers.audio_reference.as_deref(), Some("new.m4a"));
    let unversioned = accept(&format!("#TITLE:T\n#ARTIST:A\n#BPM:100\n{both}{BODY}"));
    assert_eq!(
        unversioned.song.headers.audio_reference.as_deref(),
        Some("old.mp3")
    );
    let only_audio = accept(&format!(
        "#TITLE:T\n#ARTIST:A\n#BPM:100\n#AUDIO:new.m4a\n{BODY}"
    ));
    assert_eq!(
        only_audio.song.headers.audio_reference.as_deref(),
        Some("new.m4a")
    );
    let v1_only_mp3 = accept(&format!(
        "#VERSION:1.1.0\n#TITLE:T\n#ARTIST:A\n#BPM:100\n#MP3:old.mp3\n{BODY}"
    ));
    assert_eq!(
        v1_only_mp3.song.headers.audio_reference.as_deref(),
        Some("old.mp3")
    );
}

#[test]
fn a_folder_named_artist_dash_title_supplies_missing_artist_and_title() {
    let body = format!("#BPM:100\n{BODY}");
    let file = parse(body.as_bytes(), "Some Artist - A Title - Live").unwrap();
    assert_eq!(file.song.headers.artist, "Some Artist");
    assert_eq!(file.song.headers.title, "A Title - Live");

    let own_title = format!("#TITLE:Own\n#BPM:100\n{BODY}");
    let file = parse(own_title.as_bytes(), "Some Artist - A Title").unwrap();
    assert_eq!(
        (
            file.song.headers.artist.as_str(),
            file.song.headers.title.as_str()
        ),
        ("Some Artist", "Own")
    );

    assert_eq!(
        parse(body.as_bytes(), "Some Artist").unwrap_err(),
        TxtRejection::MissingArtist
    );
    assert_eq!(
        parse(format!("#ARTIST:A\n{body}").as_bytes(), "no dash").unwrap_err(),
        TxtRejection::MissingTitle
    );
}

#[test]
fn generations_are_read_from_version() {
    let unversioned = accept(&format!("{BASE}{BODY}"));
    assert_eq!(
        unversioned.song.headers.generation,
        FormatGeneration::Unversioned
    );
    assert_eq!(unversioned.song.headers.version, None);
    for version in ["1.0.0", "1.1.0", "1.2.0", " 1.10.3 "] {
        let file = accept(&format!("#VERSION:{version}\n{BASE}{BODY}"));
        assert_eq!(
            file.song.headers.generation,
            FormatGeneration::V1,
            "{version}"
        );
    }
}

#[test]
fn version_two_or_higher_and_invalid_versions_are_rejected() {
    for version in ["2.0.0", "3.1.4"] {
        assert_eq!(
            reject(&format!("{BASE}#VERSION:{version}\n{BODY}")),
            TxtRejection::UnsupportedVersion { line: 5 },
            "{version}"
        );
    }
    for version in ["1.0", "1", "v1.0.0", "1.0.0.0", "1.a.0", "1..0"] {
        assert_eq!(
            reject(&format!("{BASE}#VERSION:{version}\n{BODY}")),
            TxtRejection::InvalidVersion { line: 5 },
            "{version}"
        );
    }
}

#[test]
fn relative_mode_is_rejected() {
    for value in ["yes", "YES", "Yes"] {
        assert_eq!(
            reject(&format!("{BASE}#RELATIVE:{value}\n{BODY}")),
            TxtRejection::RelativeMode { line: 5 }
        );
    }
    assert_eq!(
        reject(&format!("#VERSION:1.0.0\n{BASE}#RELATIVE:no\n{BODY}")),
        TxtRejection::RelativeMode { line: 6 }
    );
    accept(&format!("{BASE}#RELATIVE:no\n{BODY}"));
}

#[test]
fn encoding_is_kept_as_written() {
    let file = accept(&format!("#ENCODING:CP1252\n{BASE}{BODY}"));
    assert_eq!(file.song.headers.encoding.as_deref(), Some("CP1252"));
}
