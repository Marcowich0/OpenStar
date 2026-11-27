//! The detail page (`GET ?link=detail&id=N`) and the links in its comments.

use std::sync::LazyLock;

use regex::Regex;

use super::html::decode_entities;

/// The header row of a comment: `DD.MM.YY - HH:MM | author`, after
/// `[del] [edit] ` on the author's own comments. The comment's content is
/// the rows after it, up to the next `list_tr2` row (the next comment's
/// header, or the "Write Comment" row after the last comment).
static COMMENT_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"<tr class="list_tr2"><td>(?:\[del\] \[edit\] )?\d\d\.\d\d\.\d\d - \d\d:\d\d \|.*?</tr>"#,
    )
    .expect("valid regex")
});

const NEXT_HEADER_ROW: &str = r#"<tr class="list_tr2""#;

/// A link to a video host, in an attribute or in the comment's text. The
/// hosts are those usdb_syncer (`bohning/usdb_syncer` @ `1a4b048`,
/// `SUPPORTED_VIDEO_SOURCES_REGEX`) looks for in comments.
static VIDEO_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)\b(?:https?://)?(?:www\.)?",
        r"(?:youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|player\.vimeo\.com",
        r"|dailymotion\.com|soundcloud\.com|facebook\.com|fb\.watch|archive\.org",
        r"|web\.archive\.org|v\.animethemes\.moe|(?:[a-z0-9-]+\.)?bandcamp\.com",
        r"|bilibili\.com|cda\.pl|drive\.google\.com|nicovideo\.jp|ok\.ru|rumble\.com",
        r"|universal-music\.de)",
        r#"/[^\s"'<>]+"#,
    ))
    .expect("valid regex")
});

/// A YouTube video id in any of its link shapes: `watch?v=`, `/v/`,
/// `/embed/`, `/shorts/`, `youtu.be/`.
static YOUTUBE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)^(?:https?://)?(?:www\.|m\.)?",
        r"(?:(?:youtube\.com|youtube-nocookie\.com)/(?:watch\?(?:.*&)?v=|v/|embed/|shorts/)",
        r"|youtu\.be/)",
        r"(?P<id>[A-Za-z0-9_-]{11})",
    ))
    .expect("valid regex")
});

/// The video links in the song's comments, newest comment first (the order
/// the detail page lists them in), each comment's links in page order,
/// without repeats. YouTube links of any shape (embeds included) become
/// `https://www.youtube.com/watch?v=<id>`.
pub fn comment_links(html: &str) -> Vec<String> {
    let mut links: Vec<String> = Vec::new();
    for header in COMMENT_HEADER.find_iter(html) {
        let rest = &html[header.end()..];
        let content = &rest[..rest.find(NEXT_HEADER_ROW).unwrap_or(rest.len())];
        let content = decode_entities(content);
        for found in VIDEO_LINK.find_iter(&content) {
            let link = normalise_video_link(found.as_str());
            if !links.contains(&link) {
                links.push(link);
            }
        }
    }
    links
}

/// A video link as the picker compares them: trailing punctuation dropped,
/// YouTube links of any shape as `https://www.youtube.com/watch?v=<id>`, a
/// scheme added when there is none.
pub(crate) fn normalise_video_link(link: &str) -> String {
    let link = link.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']']);
    if let Some(youtube) = YOUTUBE.captures(link) {
        return format!("https://www.youtube.com/watch?v={}", &youtube["id"]);
    }
    if link.contains("://") {
        link.to_owned()
    } else {
        format!("https://{link}")
    }
}
