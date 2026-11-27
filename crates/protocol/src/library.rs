//! The Library index over HTTP: the playable Songs, one Song's detail, the
//! Library problems, and the state of the scan.
//!
//! - `GET /api/songs?<SongQuery>`: the playable Songs that match the
//!   [`SongQuery`], each identity once, plus the values each filter can take,
//!   as a [`SongList`]. Every field of the query is optional; without any,
//!   every playable Song is listed. A value that does not parse (a year that
//!   is not a number) is a `400`.
//! - `GET /api/songs/{id}`: one playable Song, as a [`SongDetail`]; `404`
//!   for an id that is not a playable Song.
//! - `GET /api/songs/{id}/media/{role}`: the Song's `audio`, `video`,
//!   `cover` or `background` file, with HTTP `Range` requests; the URLs in
//!   [`SongMedia`] and [`SongSummary`] point here.
//! - `GET /api/songs/{id}/high-scores`: the Song's High score tables, as
//!   [`crate::scoring::SongHighScores`]; `404` for an id that is not a
//!   playable Song.
//! - `GET /api/library/problems`: every [`LibraryProblem`].
//! - `GET /api/library/scan`: the [`ScanStatus`].
//! - `POST /api/library/rescan`: starts a Rescan unless one is running, and
//!   answers `202` with the [`ScanStatus`]. Needs no Admin PIN.
//!
//! When a scan finishes, and when a stored round adds Score records (High
//! scores in Song rows and tables), every browser gets a `changed` notice
//! with [`crate::ChangeTopic::Library`].

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::profile::PaletteKey;
use crate::scoring::{NoteFingerprint, TopHighScore};
use crate::song::{ParsedSong, TxtRejection, TxtWarning};

/// Names one indexed `.txt` while it stays in the Library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SongId(pub u32);

/// What Score records and High scores attach to: the Song's USDB id when
/// its folder has a `metadata.json` with one, otherwise its normalised artist
/// and title plus whether it is a duet. Computed from the content only, so it
/// survives renamed and moved folders. Two Songs with equal identities are
/// duplicates.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum SongIdentity {
    /// The id of the Song on USDB (`apiId` in `metadata.json`).
    Usdb { usdb_id: u32 },
    /// Artist and title, each normalised (Unicode NFKC, case-folded, trimmed,
    /// every whitespace run collapsed to one space), and the duet flag.
    ArtistTitle {
        artist: String,
        title: String,
        duet: bool,
    },
}

/// One playable Song in the list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SongSummary {
    pub id: SongId,
    /// The `.txt`, relative to the Library, with `/` between folders.
    pub path: String,
    pub artist: String,
    pub title: String,
    /// Whether the Song has two Voices.
    pub duet: bool,
    pub identity: SongIdentity,
    /// The audio file's length from ffprobe, or `#END` when it is set;
    /// `None` while the audio is not probed and there is no `#END`.
    pub length_seconds: Option<f64>,
    /// Whether the Song has a video to play.
    pub has_video: bool,
    /// Whether the Song's audio (or the one file serving as audio and
    /// video) is still being converted for the Stage: shown as "preparing",
    /// and it cannot be queued yet.
    pub preparing: bool,
    /// The cover image's URL; `None` when the Library found no cover (show
    /// the generated tile).
    pub cover: Option<String>,
    /// The generated tile's colour, from the Song's identity, so it stays the
    /// same across scans and restarts. Shown without a cover, or when the
    /// cover does not load.
    pub tile_colour: PaletteKey,
    /// The Song's top High score at any Difficulty and either Voice; `None`
    /// when no record of its identity counts.
    pub top_high_score: Option<TopHighScore>,
    /// `#YEAR`, shown as a tag on the Song's row.
    pub year: Option<i32>,
}

/// A search over the Library and its filters, sent as the URL query of
/// `GET /api/songs` (`?search=la&language=English&duet=true`). Every field
/// is optional; a Song must match all that are given. Text compares
/// case-insensitively (Unicode case folding).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct SongQuery {
    /// Words that must each appear in the Song's artist or title.
    pub search: Option<String>,
    /// One of the Song's `#LANGUAGE` values (the header split on commas).
    pub language: Option<String>,
    /// One of the Song's `#GENRE` values.
    pub genre: Option<String>,
    /// The Song's `#YEAR`.
    pub year: Option<i32>,
    /// One of the Song's `#EDITION` values.
    pub edition: Option<String>,
    /// One of the Song's `#CREATOR` values.
    pub creator: Option<String>,
    /// Only duets (`true`) or only solo Songs (`false`).
    pub duet: Option<bool>,
    /// Only Songs with a video (`true`) or without (`false`).
    pub has_video: Option<bool>,
    /// The shortest length, inclusive. A Song of unknown length never
    /// matches a length filter.
    pub min_length_seconds: Option<f64>,
    /// The longest length, inclusive.
    pub max_length_seconds: Option<f64>,
}

/// The answer to `GET /api/songs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SongList {
    /// The matching playable Songs, each identity once, by artist, then
    /// title.
    pub songs: Vec<SongSummary>,
    /// The values each filter can take in the Library, whatever the query.
    pub filters: SongFilters,
}

/// The values each filter can take: those of the playable Songs in the
/// Library (each identity once), for the filter chips. Text values are
/// listed once whatever their case (as first written), sorted
/// case-insensitively.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SongFilters {
    pub languages: Vec<String>,
    pub genres: Vec<String>,
    /// Ascending.
    pub years: Vec<i32>,
    pub editions: Vec<String>,
    pub creators: Vec<String>,
    /// The duet values present: `[false]`, `[true]` or `[false, true]`.
    pub duet: Vec<bool>,
    /// The has-video values present, as for `duet`.
    pub has_video: Vec<bool>,
    /// The shortest and longest known length; `None` when no Song has one.
    pub length: Option<LengthRange>,
}

/// The lengths of the Songs in the Library, in seconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LengthRange {
    pub min_seconds: f64,
    pub max_seconds: f64,
}

/// One media file the Stage plays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MediaFile {
    /// Served with HTTP `Range` requests.
    pub url: String,
    /// Whether the Stage plays the file served at `url`, decided by its
    /// container and codecs (from ffprobe). A file converted into the cache
    /// is served in its place at the same URL, and is native. `false` means
    /// it needs conversion (not converted yet), and also for a file not
    /// probed yet.
    pub native: bool,
}

/// The Song's video.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum SongVideo {
    /// The audio file holds the video too (the audio reference and `#VIDEO`
    /// name the same file): play it as both. `#VIDEOGAP` is ignored.
    InAudio,
    /// A separate, muted video file that follows the audio, offset by
    /// `#VIDEOGAP` (`gapSeconds`, 0 without one).
    File { file: MediaFile, gap_seconds: f64 },
}

/// What the Stage plays and shows for a Song.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SongMedia {
    pub audio: MediaFile,
    /// `None` when the Song has no video.
    pub video: Option<SongVideo>,
    /// The cover image's URL; `None`: the generated tile.
    pub cover: Option<String>,
    /// The background image's URL (`#BACKGROUND`, else the cover); `None`:
    /// the generated tile.
    pub background: Option<String>,
    /// The generated tile's colour (see [`SongSummary::tile_colour`]).
    pub tile_colour: PaletteKey,
}

/// One playable Song in full: the parsed `.txt` with units in seconds and
/// real beats, and its warnings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SongDetail {
    pub id: SongId,
    /// The `.txt`, relative to the Library, with `/` between folders.
    pub path: String,
    pub song: ParsedSong,
    /// The fingerprint of the Song's note content as loaded; the Stage
    /// returns it with the round's outcome.
    pub note_fingerprint: NoteFingerprint,
    pub identity: SongIdentity,
    pub length_seconds: Option<f64>,
    /// See [`SongSummary::preparing`].
    pub preparing: bool,
    pub media: SongMedia,
    /// The EBU R128 integrated loudness of the Song's audio file in LUFS;
    /// `null` while it is not measured (the Song plays at unity gain).
    pub loudness_lufs: Option<f64>,
    /// The Song's warnings; it plays anyway.
    pub warnings: Vec<ProblemReason>,
    /// When the server answered this detail (server time, ms since the
    /// Unix epoch). The Timing editor returns it with a save
    /// ([`crate::song::TimingSave::opened_at_ms`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub loaded_at_ms: Option<i64>,
}

/// One Library problem: a rejected file or a warning, with its reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryProblem {
    /// The `.txt`, relative to the Library, with `/` between folders.
    pub path: String,
    pub severity: ProblemSeverity,
    pub reason: ProblemReason,
}

/// Whether a problem keeps the Song from Players.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ProblemSeverity {
    /// The file is not a playable Song; Players never see it.
    Rejection,
    /// The Song plays anyway.
    Warning,
    /// A hidden duplicate: another copy with the same identity is the one
    /// shown, so Players never see this one.
    Hidden,
}

/// Why a file is a Library problem: a code plus parameters. The codes of the
/// three groups never overlap, so the frontend switches over `code` alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(export)]
pub enum ProblemReason {
    /// The `.txt` itself cannot be played.
    Rejection(TxtRejection),
    /// Something in the `.txt` that still lets the Song play.
    Warning(TxtWarning),
    /// A problem with the files the `.txt` names, or with reading it.
    File(FileProblem),
}

/// A problem with the files a `.txt` names, or with reading the `.txt`.
/// `header` is the key without `#`, upper-cased; `reference` is the value
/// as written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum FileProblem {
    /// Rejection: neither `#MP3` nor `#AUDIO` names the Song's audio.
    MissingAudioReference,
    /// Rejection: the audio reference names a file that is not found
    /// (also when it is absolute or points outside the Library).
    AudioNotFound { header: String, reference: String },
    /// Warning: `#COVER`, `#BACKGROUND` or `#VIDEO` names a file that is
    /// not found.
    MediaNotFound { header: String, reference: String },
    /// Rejection: the `.txt` could not be read.
    UnreadableFile,
    /// Warning: the `metadata.json` beside the `.txt` could not be read, is
    /// not JSON, or its `apiId` is not a USDB id. The Song is identified by
    /// its artist and title instead.
    UnreadableMetadata,
    /// Rejection: the Song's audio (or the one file serving as audio and
    /// video) does not play on the Stage and could not be converted.
    /// `file` is relative to the Library.
    AudioNotConverted { file: String },
    /// Warning: the Song's video does not play on the Stage and could not be
    /// converted; the Song plays over its background or cover.
    VideoNotConverted { file: String },
    /// Hidden: another copy of the same Song (same identity) is preferred
    /// and shown instead. `preferred` is that copy's `.txt`, relative to
    /// the Library.
    HiddenDuplicate { preferred: String },
}

/// What a scan did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScanReport {
    /// `.txt` files read and parsed: new, changed, or indexed by another
    /// parser version.
    pub read: u32,
    /// `.txt` files left as indexed, because their size and mtime are unchanged.
    pub unchanged: u32,
    /// Index entries removed because their file has gone.
    pub removed: u32,
    /// Audio and video files probed with ffprobe: new, or changed in size or
    /// mtime since they were last probed.
    pub probed: u32,
}

/// Whether a scan runs, and what the last one did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScanStatus {
    pub running: bool,
    /// How many scans have finished since the server started.
    pub finished: u32,
    /// The last finished scan, if any.
    pub last: Option<ScanReport>,
}

/// Names one trashed Song folder (a row of the trash ledger).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TrashId(#[ts(type = "number")] pub i64);

/// A Song folder in the 30-day trash (`GET /api/library/trash`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrashedSong {
    pub id: TrashId,
    /// The folder's path relative to the Library when it was deleted, with
    /// `/` between segments; a restore moves it back there.
    pub original_path: String,
    /// When it was deleted, in ms since the Unix epoch. It is purged 30 days
    /// after this.
    #[ts(type = "number")]
    pub deleted_ms: i64,
}

/// Every Song folder in the trash, the most recently deleted first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TrashList {
    pub songs: Vec<TrashedSong>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn problems_are_codes_with_parameters() {
        let problem = LibraryProblem {
            path: "A - B/song.txt".into(),
            severity: ProblemSeverity::Rejection,
            reason: ProblemReason::File(FileProblem::AudioNotFound {
                header: "MP3".into(),
                reference: "song.mp3".into(),
            }),
        };
        assert_eq!(
            serde_json::to_string(&problem).unwrap(),
            r#"{"path":"A - B/song.txt","severity":"rejection","reason":{"code":"audioNotFound","header":"MP3","reference":"song.mp3"}}"#
        );
        let warning: ProblemReason =
            serde_json::from_str(r#"{"code":"zeroLengthNote","line":3}"#).unwrap();
        assert_eq!(
            warning,
            ProblemReason::Warning(TxtWarning::ZeroLengthNote { line: 3 })
        );
        let identity = SongIdentity::ArtistTitle {
            artist: "a".into(),
            title: "b".into(),
            duet: true,
        };
        assert_eq!(
            serde_json::to_string(&identity).unwrap(),
            r#"{"kind":"artistTitle","artist":"a","title":"b","duet":true}"#
        );
        assert_eq!(
            serde_json::to_string(&SongIdentity::Usdb { usdb_id: 7 }).unwrap(),
            r#"{"kind":"usdb","usdbId":7}"#
        );
        let rejection: ProblemReason = serde_json::from_str(r#"{"code":"missingBpm"}"#).unwrap();
        assert_eq!(
            rejection,
            ProblemReason::Rejection(TxtRejection::MissingBpm)
        );
    }
}
