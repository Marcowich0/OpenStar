//! The Library index over HTTP: the playable Songs, one Song's detail, the
//! Library problems, and the state of the scan.
//!
//! - `GET /api/songs`: every playable Song, as [`SongSummary`]s.
//! - `GET /api/songs/{id}`: one playable Song, as a [`SongDetail`]; `404`
//!   for an id that is not a playable Song.
//! - `GET /api/library/problems`: every [`LibraryProblem`].
//! - `GET /api/library/scan`: the [`ScanStatus`].
//! - `POST /api/library/rescan`: starts a Rescan unless one is running, and
//!   answers `202` with the [`ScanStatus`]. Needs no Admin PIN.
//!
//! When a scan finishes, every browser gets a `changed` notice with
//! [`crate::ChangeTopic::Library`].

use serde::{Deserialize, Serialize};
use ts_rs::TS;

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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
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
    pub identity: SongIdentity,
    /// The Song's warnings; it plays anyway.
    pub warnings: Vec<ProblemReason>,
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
