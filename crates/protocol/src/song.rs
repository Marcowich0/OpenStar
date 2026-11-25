//! A Song's `.txt` as the server reads it: the interpreted headers, with units
//! normalised to seconds and real beats, plus the warning and rejection codes
//! the parser reports. The parser itself lives only in the server.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The format generation of a `.txt`. Files with a major version of 2 or
/// higher are rejected, so they never reach this type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FormatGeneration {
    /// No `#VERSION` header.
    Unversioned,
    /// `#VERSION:1.y.z`, any minor and patch.
    V1,
}

/// The headers of a `.txt` that OpenStar interprets, with units normalised.
///
/// Times are in seconds and beat rates in real beats per minute; a beat `b`
/// falls at [`SongHeaders::seconds_at_beat`]. Header values are trimmed; a
/// header with an empty value is absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SongHeaders {
    pub generation: FormatGeneration,
    /// `#VERSION` as written, for a 1.x file.
    pub version: Option<String>,
    /// `#ENCODING` as written. Encoding detection decides whether it is used.
    pub encoding: Option<String>,
    /// `#TITLE`, or the title part of a folder named `Artist - Title`.
    pub title: String,
    /// `#ARTIST`, or the artist part of a folder named `Artist - Title`.
    pub artist: String,
    /// The file the Song's audio comes from, chosen from `#MP3` and `#AUDIO`
    /// by the generation's rule. It may name a video file.
    pub audio_reference: Option<String>,
    pub mp3: Option<String>,
    pub audio: Option<String>,
    pub video: Option<String>,
    pub cover: Option<String>,
    pub background: Option<String>,
    pub vocals: Option<String>,
    pub instrumental: Option<String>,
    /// The real beat rate: `#BPM` × 4, in beats per minute. Always at least 1.
    pub beats_per_minute: f64,
    /// `#GAP` in seconds: when beat 0 falls in the audio. 0 when absent.
    pub gap_seconds: f64,
    /// `#START` in seconds.
    pub start_seconds: Option<f64>,
    /// `#END` in seconds (the file holds integer milliseconds).
    pub end_seconds: Option<f64>,
    /// `#VIDEOGAP` in seconds, signed.
    pub video_gap_seconds: Option<f64>,
    /// `#PREVIEWSTART` in seconds.
    pub preview_start_seconds: Option<f64>,
    /// `#MEDLEYSTARTBEAT`, in beats. Stored for medley mode; unused in v1.
    pub medley_start_beat: Option<i32>,
    /// `#MEDLEYENDBEAT`, in beats. Stored for medley mode; unused in v1.
    pub medley_end_beat: Option<i32>,
    pub year: Option<i32>,
    /// `#GENRE` as written; repeated headers are joined with commas.
    pub genre: Option<String>,
    /// `#GENRE` split on commas and trimmed, for filtering.
    pub genres: Vec<String>,
    pub language: Option<String>,
    pub languages: Vec<String>,
    pub edition: Option<String>,
    pub editions: Vec<String>,
    pub creator: Option<String>,
    pub creators: Vec<String>,
    /// The name of Voice `P1`: `#P1`, else `#DUETSINGERP1`.
    pub p1: Option<String>,
    /// The name of Voice `P2`: `#P2`, else `#DUETSINGERP2`.
    pub p2: Option<String>,
    /// Header lines OpenStar does not interpret, in file order. They are
    /// never dropped and are written back unchanged.
    pub unknown_headers: Vec<UnknownHeader>,
}

impl SongHeaders {
    /// The Song time, in seconds, at which beat `beat` falls:
    /// `GAP / 1000 + beat × 60 / (BPM × 4)` in the file's own units.
    pub fn seconds_at_beat(&self, beat: f64) -> f64 {
        self.gap_seconds + beat * 60.0 / self.beats_per_minute
    }
}

/// A header line OpenStar keeps without interpreting it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UnknownHeader {
    /// The 1-based line number in the file.
    pub line: u32,
    /// The text between `#` and the first colon, trimmed; the whole text
    /// after `#` when the line has no colon.
    pub key: String,
    /// The trimmed text after the first colon; absent without a colon.
    pub value: Option<String>,
}

/// Something wrong with a `.txt` that still lets the Song play.
/// `line` is 1-based; `header` is the key without `#`, upper-cased.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum TxtWarning {
    /// A header that appeared before; this later value wins.
    DuplicateHeader { line: u32, header: String },
    /// An optional number that could not be parsed; the header is absent.
    InvalidNumber { line: u32, header: String },
}

/// Why a `.txt` cannot be played. A file has exactly one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum TxtRejection {
    /// `#VERSION` is not `major.minor.patch`.
    InvalidVersion { line: u32 },
    /// `#VERSION` is valid but not 1.x (the 2.0.0 draft and later, or 0.x).
    UnsupportedVersion { line: u32 },
    /// Relative mode: `#RELATIVE:yes` in an unversioned file, or any
    /// `#RELATIVE` in a 1.x file.
    RelativeMode { line: u32 },
    /// No `#BPM` header.
    MissingBpm,
    /// `#BPM` cannot be parsed, or is below 1 after × 4.
    InvalidBpm { line: u32 },
    /// No `#ARTIST`, and the folder name does not supply one.
    MissingArtist,
    /// No `#TITLE`, and the folder name does not supply one.
    MissingTitle,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warnings_and_rejections_are_codes_with_parameters() {
        let warning = TxtWarning::DuplicateHeader {
            line: 4,
            header: "GAP".into(),
        };
        assert_eq!(
            serde_json::to_string(&warning).unwrap(),
            r#"{"code":"duplicateHeader","line":4,"header":"GAP"}"#
        );
        assert_eq!(
            serde_json::to_string(&TxtRejection::MissingBpm).unwrap(),
            r#"{"code":"missingBpm"}"#
        );
    }
}
