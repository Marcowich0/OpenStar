//! The USDB page parsers against the saved pages in `fixtures/usdb/`.

use std::path::Path;

use openstar::usdb::{
    Profile, SongListRow, UsdbPageError, comment_links, is_not_logged_in, parse_gettxt,
    parse_profile, parse_song_list, parse_song_list_total, video_tag_links,
};

fn page(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/usdb")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn the_list_page_gives_every_row_with_all_mirror_fields() {
    let rows = parse_song_list(&page("list.html"));

    assert_eq!(
        rows,
        vec![
            SongListRow {
                id: 1,
                artist: "Placeholder Artist".into(),
                title: "Placeholder Song".into(),
                genre: "Pop".into(),
                year: Some(2001),
                edition: "Placeholder Edition".into(),
                golden: true,
                language: "English, German".into(),
                creator: "placeholder-creator".into(),
                rating: 3.5,
                views: 1234,
                last_change: 1_700_000_100,
            },
            SongListRow {
                id: 2,
                artist: "Fake & Band".into(),
                title: "Re: Stacks".into(),
                genre: String::new(),
                year: None,
                edition: String::new(),
                golden: false,
                language: "French".into(),
                creator: "another-creator".into(),
                rating: 0.0,
                views: 0,
                last_change: 1_700_000_000,
            },
            SongListRow {
                id: 30001,
                artist: "Ünïcode Placeholder".into(),
                title: "Song \"Three\" 'Live'".into(),
                genre: "Rock".into(),
                year: None,
                edition: "[SC]-Placeholder".into(),
                golden: false,
                language: "English".into(),
                creator: "placeholder-creator".into(),
                rating: 5.0,
                views: 98765,
                last_change: 1_699_999_999,
            },
        ]
    );
}

#[test]
fn a_page_without_rows_gives_no_rows() {
    assert_eq!(parse_song_list(&page("not-logged-in.html")), vec![]);
}

#[test]
fn the_list_page_says_how_many_songs_the_whole_list_has() {
    assert_eq!(parse_song_list_total(&page("list.html")), Some(3));
    assert_eq!(parse_song_list_total(&page("not-logged-in.html")), None);
}

#[test]
fn the_not_logged_in_page_is_recognised() {
    assert!(is_not_logged_in(&page("not-logged-in.html")));
}

#[test]
fn pages_with_content_are_not_taken_for_the_not_logged_in_page() {
    for name in ["list.html", "gettxt-1.html", "profil.html", "home.html"] {
        assert!(!is_not_logged_in(&page(name)), "{name}");
    }
}

#[test]
fn a_detail_page_read_logged_out_is_not_the_not_logged_in_page() {
    // The comment form of a detail page read without a login carries the
    // same sentence; the detail page itself needs no login.
    assert!(page("detail-1.html").contains("You are not logged in. Login to use this function."));
    assert!(!is_not_logged_in(&page("detail-1.html")));
}

#[test]
fn the_profile_page_tells_a_login_from_none() {
    assert_eq!(
        parse_profile(&page("profil.html")),
        Profile::LoggedIn {
            user: "fake-usdb-user".into()
        }
    );
    assert_eq!(
        parse_profile(&page("logged-out/profil.html")),
        Profile::LoggedOut
    );
    assert_eq!(
        parse_profile(&page("not-logged-in.html")),
        Profile::LoggedOut
    );
}

#[test]
fn the_gettxt_page_gives_the_text_with_entities_decoded_exactly_once() {
    let text = parse_gettxt(&page("gettxt-1.html")).unwrap();

    assert!(
        text.starts_with("#ARTIST:Placeholder Artist\n#TITLE:Re: Stacks\n"),
        "{text}"
    );
    assert!(
        text.contains("\n#AUTHOR:Fish &amp; Chips <placeholder>\n"),
        "{text}"
    );
    assert!(text.contains("\n: 4 4 62 la's\n"), "{text}");
    assert!(text.ends_with("\nE"), "{text}");
}

#[test]
fn a_page_without_a_text_is_an_error() {
    assert_eq!(
        parse_gettxt(&page("not-logged-in.html")),
        Err(UsdbPageError::NoSongText)
    );
}

#[test]
fn the_video_header_gives_its_v_and_a_tags_as_links() {
    let text = parse_gettxt(&page("gettxt-1.html")).unwrap();

    assert_eq!(
        video_tag_links(&text),
        vec![
            "https://www.youtube.com/watch?v=AAAAAAAAAAA".to_owned(),
            "https://www.youtube.com/watch?v=BBBBBBBBBBB".to_owned(),
        ]
    );
}

#[test]
fn video_tags_put_v_before_a_take_full_links_and_drop_repeats() {
    let text = "#TITLE:x\n#VIDEO:a=https://vimeo.com/123456,v=youtu.be/CCCCCCCCCCC,co=x.jpg,v-trim=1\n: 0 1 0 la\nE";
    assert_eq!(
        video_tag_links(text),
        vec![
            "https://youtu.be/CCCCCCCCCCC".to_owned(),
            "https://vimeo.com/123456".to_owned()
        ]
    );
    let same = "#VIDEO:v=AAAAAAAAAAA,a=AAAAAAAAAAA\nE";
    assert_eq!(
        video_tag_links(same),
        vec!["https://www.youtube.com/watch?v=AAAAAAAAAAA".to_owned()]
    );
}

#[test]
fn a_video_header_that_is_a_file_name_gives_no_links() {
    let text = parse_gettxt(&page("gettxt-2.html")).unwrap();
    assert_eq!(video_tag_links(&text), Vec::<String>::new());
    assert_eq!(video_tag_links("#VIDEO:clip.mp4\nE"), Vec::<String>::new());
}

#[test]
fn the_detail_page_gives_the_comment_video_links_newest_first() {
    assert_eq!(
        comment_links(&page("detail-1.html")),
        vec![
            "https://www.youtube.com/watch?v=CCCCCCCCCCC".to_owned(),
            "https://vimeo.com/123456".to_owned(),
            "https://www.youtube.com/watch?v=DDDDDDDDDDD".to_owned(),
            "https://www.youtube.com/watch?v=AAAAAAAAAAA".to_owned(),
        ]
    );
}

#[test]
fn a_page_without_comments_gives_no_links() {
    assert_eq!(comment_links(&page("list.html")), Vec::<String>::new());
}
