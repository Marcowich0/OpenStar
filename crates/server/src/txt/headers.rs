//! Interpreting the header lines of a `.txt`: generations, units, the
//! duplicate and list rules, and the header rejections.

use std::collections::HashMap;

use openstar_protocol::song::{
    FormatGeneration, SongHeaders, TxtRejection, TxtWarning, UnknownHeader,
};

/// The headers OpenStar interprets, upper-cased. Every other key is unknown.
const KNOWN: &[&str] = &[
    "VERSION",
    "ENCODING",
    "RELATIVE",
    "TITLE",
    "ARTIST",
    "MP3",
    "AUDIO",
    "VIDEO",
    "COVER",
    "BACKGROUND",
    "VOCALS",
    "INSTRUMENTAL",
    "BPM",
    "GAP",
    "START",
    "END",
    "VIDEOGAP",
    "PREVIEWSTART",
    "MEDLEYSTARTBEAT",
    "MEDLEYENDBEAT",
    "YEAR",
    "GENRE",
    "LANGUAGE",
    "EDITION",
    "CREATOR",
    "P1",
    "P2",
    "DUETSINGERP1",
    "DUETSINGERP2",
];

/// Headers whose repeats are joined with commas instead of replaced.
const LISTS: &[&str] = &["GENRE", "LANGUAGE", "EDITION", "CREATOR"];

/// A header line split at its first colon, with `#` removed.
pub(super) struct HeaderLine {
    line: u32,
    key: String,
    value: Option<String>,
}

impl HeaderLine {
    /// `text` is the trimmed line without its leading `#`.
    pub(super) fn new(line: u32, text: &str) -> Self {
        match text.split_once(':') {
            Some((key, value)) => HeaderLine {
                line,
                key: key.trim().to_owned(),
                value: Some(value.trim().to_owned()),
            },
            None => HeaderLine {
                line,
                key: text.trim().to_owned(),
                value: None,
            },
        }
    }
}

/// An interpreted header's value and the line it came from.
struct Value {
    line: u32,
    text: String,
}

/// The interpreted headers, by upper-cased key, plus warnings so far.
#[derive(Default)]
struct Known {
    values: HashMap<&'static str, Value>,
    warnings: Vec<TxtWarning>,
}

impl Known {
    fn text(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(|v| v.text.as_str())
    }

    fn string(&self, key: &str) -> Option<String> {
        self.text(key).map(str::to_owned)
    }

    fn line(&self, key: &str) -> u32 {
        self.values.get(key).map_or(0, |v| v.line)
    }

    /// An optional number: absent when missing, absent with a warning when
    /// it cannot be parsed.
    fn number<T>(&mut self, key: &str, parse: impl Fn(&str) -> Option<T>) -> Option<T> {
        let value = self.values.get(key)?;
        let parsed = parse(&value.text);
        if parsed.is_none() {
            self.warnings.push(TxtWarning::InvalidNumber {
                line: value.line,
                header: key.to_owned(),
            });
        }
        parsed
    }
}

pub(super) fn interpret(
    lines: Vec<HeaderLine>,
    folder_name: &str,
) -> Result<(SongHeaders, Vec<TxtWarning>), TxtRejection> {
    let mut known = Known::default();
    let mut unknown_headers = Vec::new();

    for header in lines {
        let upper = header.key.to_uppercase();
        let (Some(key), Some(text)) = (
            KNOWN.iter().copied().find(|k| *k == upper),
            header.value.clone(),
        ) else {
            unknown_headers.push(UnknownHeader {
                line: header.line,
                key: header.key,
                value: header.value,
            });
            continue;
        };
        if text.is_empty() {
            continue;
        }
        match known.values.get_mut(key) {
            Some(previous) if LISTS.contains(&key) => {
                previous.text = format!("{}, {}", previous.text, text);
            }
            Some(previous) => {
                known.warnings.push(TxtWarning::DuplicateHeader {
                    line: header.line,
                    header: key.to_owned(),
                });
                *previous = Value {
                    line: header.line,
                    text,
                };
            }
            None => {
                known.values.insert(
                    key,
                    Value {
                        line: header.line,
                        text,
                    },
                );
            }
        }
    }

    let generation = match known.text("VERSION") {
        None => FormatGeneration::Unversioned,
        Some(version) => {
            let line = known.line("VERSION");
            match parse_version(version) {
                None => return Err(TxtRejection::InvalidVersion { line }),
                Some(1) => FormatGeneration::V1,
                Some(_) => return Err(TxtRejection::UnsupportedVersion { line }),
            }
        }
    };

    if let Some(relative) = known.text("RELATIVE")
        && (generation == FormatGeneration::V1 || relative.eq_ignore_ascii_case("yes"))
    {
        return Err(TxtRejection::RelativeMode {
            line: known.line("RELATIVE"),
        });
    }

    let Some(bpm) = known.text("BPM") else {
        return Err(TxtRejection::MissingBpm);
    };
    let beats_per_minute = match parse_decimal(bpm).map(|bpm| bpm * 4.0) {
        Some(rate) if rate >= 1.0 => rate,
        _ => {
            return Err(TxtRejection::InvalidBpm {
                line: known.line("BPM"),
            });
        }
    };

    let (folder_artist, folder_title) = match folder_name.split_once(" - ") {
        Some((artist, title)) => (non_empty(artist), non_empty(title)),
        None => (None, None),
    };
    let artist = known
        .string("ARTIST")
        .or(folder_artist)
        .ok_or(TxtRejection::MissingArtist)?;
    let title = known
        .string("TITLE")
        .or(folder_title)
        .ok_or(TxtRejection::MissingTitle)?;

    let mp3 = known.string("MP3");
    let audio = known.string("AUDIO");
    let audio_reference = match generation {
        FormatGeneration::V1 => audio.clone().or_else(|| mp3.clone()),
        FormatGeneration::Unversioned => mp3.clone().or_else(|| audio.clone()),
    };

    let gap_ms = known.number("GAP", parse_decimal).unwrap_or(0.0);
    let start_seconds = known.number("START", parse_decimal);
    let end_ms = known.number("END", |s| s.parse::<i64>().ok());
    let video_gap_seconds = known.number("VIDEOGAP", parse_decimal);
    let preview_start_seconds = known.number("PREVIEWSTART", parse_decimal);
    let medley_start_beat = known.number("MEDLEYSTARTBEAT", |s| s.parse().ok());
    let medley_end_beat = known.number("MEDLEYENDBEAT", |s| s.parse().ok());
    let year = known.number("YEAR", |s| s.parse().ok());

    let headers = SongHeaders {
        generation,
        version: known.string("VERSION"),
        encoding: known.string("ENCODING"),
        title,
        artist,
        audio_reference,
        mp3,
        audio,
        video: known.string("VIDEO"),
        cover: known.string("COVER"),
        background: known.string("BACKGROUND"),
        vocals: known.string("VOCALS"),
        instrumental: known.string("INSTRUMENTAL"),
        beats_per_minute,
        gap_seconds: gap_ms / 1000.0,
        start_seconds,
        end_seconds: end_ms.map(|ms| ms as f64 / 1000.0),
        video_gap_seconds,
        preview_start_seconds,
        medley_start_beat,
        medley_end_beat,
        year,
        genre: known.string("GENRE"),
        genres: split_list(known.text("GENRE")),
        language: known.string("LANGUAGE"),
        languages: split_list(known.text("LANGUAGE")),
        edition: known.string("EDITION"),
        editions: split_list(known.text("EDITION")),
        creator: known.string("CREATOR"),
        creators: split_list(known.text("CREATOR")),
        p1: known.string("P1").or_else(|| known.string("DUETSINGERP1")),
        p2: known.string("P2").or_else(|| known.string("DUETSINGERP2")),
        unknown_headers,
    };

    let mut warnings = known.warnings;
    warnings.sort_by_key(TxtWarning::line);
    Ok((headers, warnings))
}

/// The major version of a `major.minor.patch` version, if it is one.
fn parse_version(text: &str) -> Option<u64> {
    let parts: Vec<&str> = text.split('.').collect();
    let [major, minor, patch] = parts.as_slice() else {
        return None;
    };
    let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !(numeric(major) && numeric(minor) && numeric(patch)) {
        return None;
    }
    major.parse().ok()
}

/// A decimal number with a point or a comma as its separator.
fn parse_decimal(text: &str) -> Option<f64> {
    let allowed = |c: char| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | ',');
    if !text.chars().all(allowed) {
        return None;
    }
    text.replace(',', ".")
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
}

fn non_empty(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn split_list(text: Option<&str>) -> Vec<String> {
    text.map(|t| t.split(',').filter_map(non_empty).collect())
        .unwrap_or_default()
}
