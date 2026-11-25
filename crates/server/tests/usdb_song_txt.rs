//! The rewrite of USDB's text into the `song.txt` a Download writes, against
//! the saved `gettxt` pages and hand-written expected files in
//! `fixtures/usdb/song-txt/`.

use std::path::{Path, PathBuf};

use openstar::usdb::{UsdbCover, parse_gettxt, rewrite_song_txt};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/usdb")
        .join(name)
}

fn usdb_text(page: &str) -> String {
    parse_gettxt(&std::fs::read_to_string(fixture(page)).unwrap()).unwrap()
}

fn expected(name: &str) -> Vec<u8> {
    std::fs::read(fixture(&format!("song-txt/{name}"))).unwrap()
}

#[test]
fn a_text_with_a_cover_points_mp3_video_and_cover_at_the_downloaded_files() {
    let song_txt = rewrite_song_txt(&usdb_text("gettxt-1.html"), UsdbCover::Present);

    assert_eq!(
        String::from_utf8_lossy(song_txt.as_bytes()),
        String::from_utf8_lossy(&expected("1-with-cover.txt"))
    );
}

#[test]
fn a_versioned_text_without_a_cover_also_sets_audio_and_loses_its_cover() {
    let song_txt = rewrite_song_txt(&usdb_text("gettxt-2.html"), UsdbCover::Absent);

    assert_eq!(
        String::from_utf8_lossy(song_txt.as_bytes()),
        String::from_utf8_lossy(&expected("2-without-cover.txt"))
    );
}

#[test]
fn header_values_are_kept_whole_at_their_colons() {
    let song_txt = rewrite_song_txt(&usdb_text("gettxt-1.html"), UsdbCover::Present);

    assert!(song_txt.contains("\n#TITLE:Re: Stacks\n"), "{song_txt}");
    let file =
        openstar::txt::parse(song_txt.as_bytes(), "Placeholder Artist - Re: Stacks").unwrap();
    assert_eq!(file.song.headers.title, "Re: Stacks");
}

#[test]
fn the_result_is_utf8_without_a_bom_and_never_gains_a_version() {
    let text = format!("\u{feff}{}", usdb_text("gettxt-1.html"));
    let song_txt = rewrite_song_txt(&text, UsdbCover::Present);

    assert!(!song_txt.starts_with('\u{feff}'));
    assert!(song_txt.starts_with("#ARTIST:"));
    assert!(!song_txt.to_ascii_uppercase().contains("#VERSION"));
    assert!(!song_txt.contains("#AUDIO"));
}

#[test]
fn missing_headers_are_added_after_the_last_header_with_its_line_ending() {
    let text = "#TITLE:Re: Stacks\r\n#ARTIST:Placeholder\r\n#BPM:300\r\n: 0 4 60 la\r\nE\r\n";

    assert_eq!(
        rewrite_song_txt(text, UsdbCover::Present),
        "#TITLE:Re: Stacks\r\n#ARTIST:Placeholder\r\n#BPM:300\r\n#MP3:video.mp4\r\n#VIDEO:video.mp4\r\n#COVER:cover.jpg\r\n: 0 4 60 la\r\nE\r\n"
    );
}

#[test]
fn repeated_and_lower_case_headers_are_set_once() {
    let text = "#TITLE:x\n#mp3:a.mp3\n#MP3:b.mp3\n#Background:bg.jpg\n#cover:c.jpg\n#COVER:d.jpg\n: 0 4 60 la\nE";

    assert_eq!(
        rewrite_song_txt(text, UsdbCover::Present),
        "#TITLE:x\n#MP3:video.mp4\n#COVER:cover.jpg\n#VIDEO:video.mp4\n: 0 4 60 la\nE"
    );
}

#[test]
fn the_rewrite_leaves_the_body_untouched() {
    let text = usdb_text("gettxt-1.html");
    let song_txt = rewrite_song_txt(&text, UsdbCover::Present);

    let body = |t: &str| t[t.find("\n:").unwrap()..].to_owned();
    assert_eq!(body(&song_txt), body(&text));
}

#[test]
fn a_text_of_headers_only_gets_its_new_headers_on_lines_of_their_own() {
    assert_eq!(
        rewrite_song_txt("#TITLE:x\n#BACKGROUND:bg.jpg", UsdbCover::Absent),
        "#TITLE:x\n#MP3:video.mp4\n#VIDEO:video.mp4\n"
    );
    assert_eq!(
        rewrite_song_txt("#TITLE:x", UsdbCover::Absent),
        "#TITLE:x\n#MP3:video.mp4\n#VIDEO:video.mp4\n"
    );
}
