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

/// A Song's `.txt` as parsed: its headers and its Voices.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ParsedSong {
    pub headers: SongHeaders,
    /// One Voice for a solo Song; two (`P1`, then `P2`) for a duet. A Song
    /// is a duet when its body has any `P` line.
    pub voices: Vec<Voice>,
}

/// One sung part of a Song: its Lines in file order. Each Voice has its own
/// beat timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Voice {
    pub lines: Vec<Line>,
}

/// One row of lyrics in a Voice and the Notes sung on it. Never empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Line {
    /// The Line's Notes in file order; never re-sorted.
    pub notes: Vec<Note>,
    /// The Line end marker that closed this Line; absent for a Voice's last
    /// Line when `E` (or the end of the file) closes it.
    pub end: Option<LineEnd>,
}

/// A Line end marker, `- beat`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LineEnd {
    /// The beat the marker names, relative to `#GAP`.
    pub beat: i32,
    /// The 1-based line number of the marker in the file.
    pub line: u32,
}

/// One syllable to be sung, from a Note line `type start length pitch text`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Note {
    pub kind: NoteKind,
    /// The first beat, relative to `#GAP`.
    pub start: i32,
    /// How many beats the Note lasts, as written. A length below 1 is made
    /// [`NoteKind::Freestyle`].
    pub length: i32,
    /// Semitones from C4 (0 = MIDI 60).
    pub pitch: i32,
    /// The lyric, with its leading and trailing spaces kept (they carry word
    /// boundaries).
    pub text: String,
    /// The 1-based line number of the Note line in the file.
    pub line: u32,
}

/// What kind of Note a Note line holds, from its type character.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NoteKind {
    /// `:`, weight 1 per beat.
    Normal,
    /// `*`, weight 2 per beat.
    Golden,
    /// `R`: any voice hits, pitch ignored; weight 1 per beat.
    Rap,
    /// `G`: a golden Rap note; weight 2 per beat.
    GoldenRap,
    /// `F`: shown, never scored.
    Freestyle,
}

/// One timing operation of a Timing edit: the only changes the Timing editor
/// sends to the server's `.txt` patcher. Notes and Line end markers are named
/// by the 1-based line number they have in the file as parsed (`Note::line`,
/// `LineEnd::line`), never renumbered by earlier operations. Later
/// operations on the same value win. Units are the parser's normalised ones.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum TimingOperation {
    /// `#GAP`, in seconds; the file gets whole milliseconds.
    SetGap { seconds: f64 },
    /// `#BPM` as the real beat rate (`#BPM` × 4, as in
    /// [`SongHeaders::beats_per_minute`]); the file gets it ÷ 4.
    SetBpm { beats_per_minute: f64 },
    /// `#VIDEOGAP`, in seconds.
    SetVideoGap { seconds: f64 },
    /// The first beat of the Note on line `line`.
    SetNoteStart { line: u32, start: i32 },
    /// The length in beats of the Note on line `line`; at least 1.
    SetNoteLength { line: u32, length: i32 },
    /// The beat of the Line end marker on line `line`.
    SetLineEnd { line: u32, beat: i32 },
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
    /// A Note with a length below 1, made Freestyle.
    ZeroLengthNote { line: u32 },
    /// A Note that shares a beat with an earlier Note of the same Voice.
    /// Each beat belongs to the first Note in the file that covers it.
    OverlappingNotes { line: u32, earlier_line: u32 },
    /// A body line that is not a Note, a Line end marker or a Voice change
    /// (for example an unofficial `B` line); it is skipped.
    UnknownBodyLine { line: u32 },
}

impl TxtWarning {
    /// The 1-based line the warning is about.
    pub fn line(&self) -> u32 {
        match self {
            TxtWarning::DuplicateHeader { line, .. }
            | TxtWarning::InvalidNumber { line, .. }
            | TxtWarning::ZeroLengthNote { line }
            | TxtWarning::OverlappingNotes { line, .. }
            | TxtWarning::UnknownBodyLine { line } => *line,
        }
    }
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
    /// No Notes at all; a file that ends inside the header has none.
    NoNotes,
    /// A duet (a body with any `P` line) whose Voice `voice` (1 or 2) has
    /// no Notes.
    DuetVoiceWithoutNotes { voice: u8 },
    /// A line that starts with a Note type, but whose start, length or pitch
    /// is not an integer.
    InvalidNoteLine { line: u32 },
    /// A `P` line whose number is not 1 or 2.
    InvalidVoice { line: u32 },
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

    #[test]
    fn voices_lines_and_notes_are_camel_case() {
        let line = Line {
            notes: vec![Note {
                kind: NoteKind::GoldenRap,
                start: 12,
                length: 4,
                pitch: -3,
                text: " la ".into(),
                line: 8,
            }],
            end: Some(LineEnd { beat: 18, line: 9 }),
        };
        assert_eq!(
            serde_json::to_string(&Voice { lines: vec![line] }).unwrap(),
            r#"{"lines":[{"notes":[{"kind":"goldenRap","start":12,"length":4,"pitch":-3,"text":" la ","line":8}],"end":{"beat":18,"line":9}}]}"#
        );
    }

    #[test]
    fn timing_operations_are_tagged_by_op_in_the_writer_fixture_shape() {
        let ops = vec![
            TimingOperation::SetGap { seconds: 0.753 },
            TimingOperation::SetBpm {
                beats_per_minute: 865.04,
            },
            TimingOperation::SetVideoGap { seconds: -0.25 },
            TimingOperation::SetNoteStart {
                line: 12,
                start: 40,
            },
            TimingOperation::SetNoteLength {
                line: 12,
                length: 3,
            },
            TimingOperation::SetLineEnd { line: 13, beat: 44 },
        ];
        let json = serde_json::to_string(&ops).unwrap();
        assert_eq!(
            json,
            concat!(
                r#"[{"op":"setGap","seconds":0.753},"#,
                r#"{"op":"setBpm","beatsPerMinute":865.04},"#,
                r#"{"op":"setVideoGap","seconds":-0.25},"#,
                r#"{"op":"setNoteStart","line":12,"start":40},"#,
                r#"{"op":"setNoteLength","line":12,"length":3},"#,
                r#"{"op":"setLineEnd","line":13,"beat":44}]"#
            )
        );
        let back: Vec<TimingOperation> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ops);
    }
}
