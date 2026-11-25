//! Encoding detection, through `openstar::txt::parse`: the BOM, the 1.x rule,
//! `#ENCODING` in an unversioned file, and the UTF-8 check with the
//! `chardetng` guess. Fixture snapshots are in `txt_fixtures.rs`.

use openstar::txt::{TxtEncoding, TxtFile, parse};

const BOM: &[u8] = b"\xEF\xBB\xBF";

/// A playable file: `headers` (each line ending in `\n`) go first, then the
/// title, artist, BPM and audio headers, then one Note whose text is `lyric`.
fn song(headers: &[u8], lyric: &[u8]) -> Vec<u8> {
    [
        headers,
        b"#TITLE:Placeholder Title\n#ARTIST:Placeholder Artist\n#BPM:100\n#MP3:song.mp3\n: 0 4 0 ",
        lyric,
        b"\nE\n",
    ]
    .concat()
}

fn accept(bytes: &[u8]) -> TxtFile {
    parse(bytes, "folder").expect("the file is accepted")
}

fn lyric(file: &TxtFile) -> &str {
    &file.song.voices[0].lines[0].notes[0].text
}

#[test]
fn a_bom_makes_the_file_utf8_and_stays_out_of_headers_and_lyrics() {
    let bytes = [
        BOM,
        b"#TITLE:Caf\xC3\xA9\n#ARTIST:A\n#BPM:100\n#MP3:s.mp3\n: 0 4 0 \xC3\xA9\nE\n",
    ]
    .concat();
    let file = accept(&bytes);

    assert_eq!(file.encoding, TxtEncoding::Utf8);
    assert!(file.bom);
    assert_eq!(file.song.headers.title, "Café");
    assert_eq!(lyric(&file), "é");
    // The line model keeps the BOM, so the file comes back byte for byte.
    assert!(file.lines[0].bytes.starts_with(BOM));
}

#[test]
fn a_bom_wins_over_encoding() {
    let bytes = [BOM, &song(b"#ENCODING:CP1252\n", b"\xC3\xA9")].concat();
    let file = accept(&bytes);

    assert_eq!(file.encoding, TxtEncoding::Utf8);
    assert!(file.bom);
    assert_eq!(lyric(&file), "é");
}

#[test]
fn a_bom_does_not_hide_the_first_header() {
    let file = accept(&[BOM, &song(b"", b"La")].concat());
    assert_eq!(file.song.headers.title, "Placeholder Title");
    assert!(file.song.headers.unknown_headers.is_empty());
}

#[test]
fn a_file_without_bom_has_no_bom() {
    let file = accept(&song(b"", b"La"));
    assert!(!file.bom);
}

#[test]
fn a_1x_file_is_utf8_whatever_its_encoding_header_says() {
    let file = accept(&song(b"#VERSION:1.1.0\n#ENCODING:CP1252\n", b"\xC3\xA9"));

    assert_eq!(file.encoding, TxtEncoding::Utf8);
    assert_eq!(lyric(&file), "é");
    assert_eq!(file.song.headers.encoding.as_deref(), Some("CP1252"));
}

#[test]
fn a_1x_file_with_invalid_utf8_is_still_utf8() {
    let file = accept(&song(b"#VERSION:1.0.0\n", b"Caf\xE9"));

    assert_eq!(file.encoding, TxtEncoding::Utf8);
    assert_eq!(lyric(&file), "Caf\u{FFFD}");
}

#[test]
fn encoding_decides_in_an_unversioned_file() {
    // C3 A9 is valid UTF-8 ("é"), but the header says CP1252: "Ã©".
    let file = accept(&song(b"#ENCODING:CP1252\n", b"\xC3\xA9"));
    assert_eq!(file.encoding, TxtEncoding::Cp1252);
    assert_eq!(lyric(&file), "Ã©");

    // B9 is "ą" in CP1250 and "¹" in CP1252.
    let file = accept(&song(b"#ENCODING:CP1250\n", b"\xB9"));
    assert_eq!(file.encoding, TxtEncoding::Cp1250);
    assert_eq!(lyric(&file), "ą");

    let file = accept(&song(b"#ENCODING:UTF8\n", b"\xC3\xA9"));
    assert_eq!(file.encoding, TxtEncoding::Utf8);
    assert_eq!(lyric(&file), "é");
}

#[test]
fn encoding_names_are_matched_without_dashes_and_case() {
    for (header, expected) in [
        (&b"#ENCODING:utf-8\n"[..], TxtEncoding::Utf8),
        (b"#ENCODING:cp-1250\n", TxtEncoding::Cp1250),
        (b"#encoding: Cp1252 \n", TxtEncoding::Cp1252),
    ] {
        let file = accept(&song(header, b"La"));
        assert_eq!(
            file.encoding,
            expected,
            "{}",
            String::from_utf8_lossy(header)
        );
    }
}

#[test]
fn the_last_encoding_header_counts() {
    let file = accept(&song(b"#ENCODING:UTF8\n#ENCODING:CP1250\n", b"\xB9"));
    assert_eq!(file.encoding, TxtEncoding::Cp1250);
}

#[test]
fn other_encoding_values_fall_through_to_detection() {
    for header in [
        &b"#ENCODING:LOCALE\n"[..],
        b"#ENCODING:AUTO\n",
        b"#ENCODING:ISO-8859-1\n",
        b"#ENCODING:\n",
    ] {
        let utf8 = accept(&song(header, b"\xC3\xA9"));
        assert_eq!(utf8.encoding, TxtEncoding::Utf8);
        assert_eq!(lyric(&utf8), "é");

        let single_byte = accept(&song(header, b"Caf\xE9"));
        assert_eq!(single_byte.encoding, TxtEncoding::Cp1252);
        assert_eq!(lyric(&single_byte), "Café");
    }
}

#[test]
fn a_valid_utf8_file_without_hints_is_utf8() {
    let file = accept(&song(b"", "żółć".as_bytes()));
    assert_eq!(file.encoding, TxtEncoding::Utf8);
    assert_eq!(lyric(&file), "żółć");
}

#[test]
fn an_invalid_utf8_file_is_guessed_as_cp1252() {
    let file = accept(&song(b"", b"Caf\xE9 cr\xE8me br\xFBl\xE9e d\xE9j\xE0 vu"));
    assert_eq!(file.encoding, TxtEncoding::Cp1252);
    assert_eq!(lyric(&file), "Café crème brûlée déjà vu");
}

#[test]
fn an_invalid_utf8_file_is_guessed_as_cp1250() {
    // "Příliš žluťoučký kůň úpěl ďábelské ódy" in CP1250.
    let text =
        b"P\xF8\xEDli\x9A \x9Elu\x9Dou\xE8k\xFD k\xF9\xF2 \xFAp\xECl \xEF\xE1belsk\xE9 \xF3dy";
    let file = accept(&song(b"", text));
    assert_eq!(file.encoding, TxtEncoding::Cp1250);
    assert_eq!(lyric(&file), "Příliš žluťoučký kůň úpěl ďábelské ódy");
}

#[test]
fn a_guess_other_than_cp1252_or_cp1250_falls_back_to_cp1252() {
    // "Привет мир, это песня" in CP1251, which chardetng guesses as Cyrillic.
    let text = b"\xCF\xF0\xE8\xE2\xE5\xF2 \xEC\xE8\xF0, \xFD\xF2\xEE \xEF\xE5\xF1\xED\xFF";
    let file = accept(&song(b"", text));
    assert_eq!(file.encoding, TxtEncoding::Cp1252);
}

#[test]
fn encoding_names_round_trip() {
    for encoding in [TxtEncoding::Utf8, TxtEncoding::Cp1252, TxtEncoding::Cp1250] {
        assert_eq!(TxtEncoding::from_name(encoding.name()), Some(encoding));
    }
    assert_eq!(TxtEncoding::Utf8.name(), "UTF8");
    assert_eq!(TxtEncoding::Cp1252.name(), "CP1252");
    assert_eq!(TxtEncoding::Cp1250.name(), "CP1250");
    assert_eq!(TxtEncoding::from_name("LOCALE"), None);
}
