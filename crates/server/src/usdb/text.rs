//! The song text (`POST ?link=gettxt&id=N` with `wd=1`) and the video links
//! in its `#VIDEO` header.

use std::sync::LazyLock;

use regex::Regex;

use super::html::decode_entities;
use super::song_txt::header_lines;

/// A page that does not hold what its parser looks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UsdbPageError {
    /// The `gettxt` page has no `<textarea>` with the text.
    NoSongText,
}

static TEXTAREA: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<textarea\b[^>]*>(?P<text>.*?)</textarea\s*>").expect("valid regex")
});

/// The song's text from the `gettxt` page: the content of its first
/// `<textarea>`, with HTML entities decoded exactly once (`&amp;amp;`
/// becomes `&amp;`). As in HTML, one line break right after `<textarea>`
/// is not part of the text.
pub fn parse_gettxt(html: &str) -> Result<String, UsdbPageError> {
    let raw = TEXTAREA
        .captures(html)
        .ok_or(UsdbPageError::NoSongText)?
        .name("text")
        .map_or("", |text| text.as_str());
    let raw = raw
        .strip_prefix("\r\n")
        .or_else(|| raw.strip_prefix('\n'))
        .unwrap_or(raw);
    Ok(decode_entities(raw))
}

/// The links in the `v=` (video) and `a=` (audio) tags of the `#VIDEO`
/// header, in that order and without repeats: the first video candidates
/// of a Download.
///
/// The header holds comma-separated `key=value` tags (a `,` inside a value
/// is written `%2C`); a header without `=` is a plain file name and gives
/// nothing. A value is a full link, a link without its scheme, or a bare
/// YouTube (11 characters) or Vimeo (2 to 10 digits) id. As usdb_syncer
/// does, anything from the first `&` on is dropped.
pub fn video_tag_links(text: &str) -> Vec<String> {
    let Some(video) = header_lines(text)
        .into_iter()
        .find(|header| header.key.eq_ignore_ascii_case("VIDEO"))
        .and_then(|header| header.value)
    else {
        return Vec::new();
    };
    if !video.contains('=') {
        return Vec::new();
    }
    let tags: Vec<(String, String)> = video
        .split(',')
        .filter_map(|tag| tag.trim_start().split_once('='))
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.replace("%2C", ",")))
        .collect();

    let mut links: Vec<String> = Vec::new();
    for wanted in ["v", "a"] {
        for (_, value) in tags.iter().filter(|(key, _)| key == wanted) {
            if let Some(link) = link_from_resource(value)
                && !links.contains(&link)
            {
                links.push(link);
            }
        }
    }
    links
}

static VIMEO_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{2,10}$").expect("valid regex"));
static YOUTUBE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{11}$").expect("valid regex"));

fn link_from_resource(value: &str) -> Option<String> {
    let resource = value.split('&').next().unwrap_or_default().trim();
    if resource.contains("://") {
        Some(resource.to_owned())
    } else if resource.contains('/') {
        Some(format!("https://{resource}"))
    } else if VIMEO_ID.is_match(resource) {
        Some(format!("https://vimeo.com/{resource}"))
    } else if YOUTUBE_ID.is_match(resource) {
        Some(format!("https://www.youtube.com/watch?v={resource}"))
    } else {
        None
    }
}
