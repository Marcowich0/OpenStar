//! Reading the header lines of USDB's text, and the rewrite into the
//! `song.txt` a Download writes.

/// One header line (`#KEY:value`) of the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HeaderLine<'a> {
    /// The key as written, without `#`, trimmed.
    pub key: &'a str,
    /// Everything after the first `:`, whole; `None` when there is no `:`.
    pub value: Option<&'a str>,
}

/// The header lines: the lines starting with `#` (after leading
/// whitespace) before the first line that is neither blank nor a header,
/// as the Library's `.txt` parser reads them.
pub(super) fn header_lines(text: &str) -> Vec<HeaderLine<'_>> {
    let mut headers = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(header) = trimmed.strip_prefix('#') else {
            break;
        };
        headers.push(match header.split_once(':') {
            Some((key, value)) => HeaderLine {
                key: key.trim(),
                value: Some(value),
            },
            None => HeaderLine {
                key: header.trim(),
                value: None,
            },
        });
    }
    headers
}

/// Whether USDB has a cover for the song (and the Download writes
/// `cover.jpg`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsdbCover {
    Present,
    Absent,
}

/// What becomes of one header in the rewrite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rule {
    /// The first line with this key is set to `#KEY:value`, repeats are
    /// dropped, and the header is added when the text has none.
    Set(&'static str, &'static str),
    /// Every line with this key is dropped.
    Remove(&'static str),
}

impl Rule {
    fn key(self) -> &'static str {
        match self {
            Rule::Set(key, _) | Rule::Remove(key) => key,
        }
    }
}

/// Turns USDB's text (with HTML entities already decoded once, as
/// [`parse_gettxt`](super::parse_gettxt) gives it) into the `song.txt` a
/// Download writes:
///
/// - `#MP3` and `#VIDEO` are set to `video.mp4`; when the text has a
///   `#VERSION` header, `#AUDIO` is too (in 1.x `#AUDIO` wins over `#MP3`);
/// - `#COVER` is set to `cover.jpg` when USDB has a cover and removed when
///   it has none;
/// - `#BACKGROUND` is removed, because no background is fetched;
/// - a header that is set replaces its first line in place; a missing one
///   is added after the last header line, with that line's ending.
///
/// Every other line is kept byte for byte, so a header value is never cut
/// at a colon, and no `#VERSION` is ever added. Keys are matched without
/// regard to case. A leading BOM is dropped: the result is UTF-8 without
/// one.
pub fn rewrite_song_txt(text: &str, cover: UsdbCover) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let has_version = header_lines(text)
        .iter()
        .any(|header| header.key.eq_ignore_ascii_case("VERSION"));

    let mut rules = vec![
        Rule::Set("MP3", "video.mp4"),
        Rule::Set("VIDEO", "video.mp4"),
    ];
    if has_version {
        rules.push(Rule::Set("AUDIO", "video.mp4"));
    }
    rules.push(match cover {
        UsdbCover::Present => Rule::Set("COVER", "cover.jpg"),
        UsdbCover::Absent => Rule::Remove("COVER"),
    });
    rules.push(Rule::Remove("BACKGROUND"));

    let lines = split_lines(text);
    let header_end = lines
        .iter()
        .take_while(|(line, _)| line.trim().is_empty() || line.trim().starts_with('#'))
        .count();
    let last_header = lines[..header_end]
        .iter()
        .rposition(|(line, _)| line.trim().starts_with('#'));

    let mut done: Vec<&'static str> = Vec::new();
    let mut out = String::with_capacity(text.len() + 64);
    for (index, (line, ending)) in lines.iter().enumerate() {
        let rule = (index < header_end)
            .then(|| header_key(line))
            .flatten()
            .and_then(|key| {
                rules
                    .iter()
                    .find(|rule| rule.key().eq_ignore_ascii_case(key))
            });
        match rule {
            None => {
                out.push_str(line);
                out.push_str(ending);
            }
            Some(Rule::Remove(_)) => {}
            Some(Rule::Set(key, value)) => {
                if !done.contains(key) {
                    done.push(key);
                    out.push_str(&format!("#{key}:{value}{ending}"));
                }
            }
        }
        if Some(index) == last_header {
            let ending = if ending.is_empty() {
                first_ending(&lines)
            } else {
                ending
            };
            if !out.is_empty() && !out.ends_with(['\r', '\n']) {
                out.push_str(ending);
            }
            push_missing(&mut out, &rules, &mut done, ending);
        }
    }
    if last_header.is_none() {
        let mut added = String::new();
        push_missing(&mut added, &rules, &mut done, first_ending(&lines));
        out.insert_str(0, &added);
    }
    out
}

/// Adds every header a rule sets that is not written yet.
fn push_missing(out: &mut String, rules: &[Rule], done: &mut Vec<&'static str>, ending: &str) {
    for rule in rules {
        if let Rule::Set(key, value) = *rule
            && !done.contains(&key)
        {
            done.push(key);
            out.push_str(&format!("#{key}:{value}{ending}"));
        }
    }
}

/// The key of a header line (`#KEY:value`), trimmed; `None` for any other
/// line.
fn header_key(line: &str) -> Option<&str> {
    let header = line.trim().strip_prefix('#')?;
    Some(header.split_once(':').map_or(header, |(key, _)| key).trim())
}

/// The text's lines, each with its ending (`\r\n`, `\n`, `\r`, or empty
/// for a last line without one).
fn split_lines(text: &str) -> Vec<(&str, &str)> {
    let mut lines = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let Some(at) = rest.find(['\r', '\n']) else {
            lines.push((rest, ""));
            break;
        };
        let ending_len = if rest[at..].starts_with("\r\n") { 2 } else { 1 };
        lines.push((&rest[..at], &rest[at..at + ending_len]));
        rest = &rest[at + ending_len..];
    }
    lines
}

/// The ending new lines get when the last header line has none: the
/// text's first line ending, else `\n`.
fn first_ending<'a>(lines: &[(&'a str, &'a str)]) -> &'a str {
    lines
        .iter()
        .map(|(_, ending)| *ending)
        .find(|ending| !ending.is_empty())
        .unwrap_or("\n")
}
