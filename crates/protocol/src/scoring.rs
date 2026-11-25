//! Scoring values the Stage computes and the server stores.
//!
//! The Stage turns each Mic's Pitch readings into one [`BeatValue`] per Beat
//! (the Beat-value computation lives only in TypeScript, in
//! `web/src/scoring/`). A Score record keeps the value of every Beat in its
//! Beat range, so the record can be rescored or graphed later.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::library::{SongId, SongIdentity};
use crate::party::PartyId;
use crate::profile::{Avatar, Difficulty, PaletteKey, ProfileId};
use crate::song::NoteKind;

/// What one Player sang in one Beat, independent of the Note and the
/// Difficulty.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum BeatValue {
    /// Too few readings passed the Mic threshold, or the Beat had none.
    NoVoice,
    /// Enough readings passed the Mic threshold, but too few were voiced:
    /// enough for a Rap note, not for a pitched Note.
    VoiceWithoutPitch,
    /// Enough readings were voiced; the lower median of their pitches.
    Pitch {
        /// A fractional MIDI note number (A4 = 69), always one of the Beat's
        /// actual readings.
        pitch: f64,
    },
}

/// Identifies a Song's note content at one moment: the SHA-256, in 64
/// lowercase hex digits, of the Song's [`NoteSnapshot`] as JSON. It does not
/// depend on the file's bytes, encoding or line endings; any Timing edit
/// changes it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NoteFingerprint(pub String);

/// The note content a [`NoteFingerprint`] covers: `#GAP` and `#BPM` in
/// normalised units and, for each Voice, its Lines and Notes. Stored once per
/// fingerprint, so an old Score record can be graphed against the Notes it
/// was sung to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NoteSnapshot {
    /// `#GAP` in seconds.
    pub gap_seconds: f64,
    /// The real beat rate, `#BPM` × 4.
    pub beats_per_minute: f64,
    /// The Voices in Song order (`P1`, then `P2`).
    pub voices: Vec<SnapshotVoice>,
}

/// One Voice of a [`NoteSnapshot`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SnapshotVoice {
    pub lines: Vec<SnapshotLine>,
}

/// One Line of a [`NoteSnapshot`]: its Notes in file order and the beat of
/// the Line end marker that closed it, if one did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SnapshotLine {
    pub notes: Vec<SnapshotNote>,
    pub end: Option<i32>,
}

/// One Note of a [`NoteSnapshot`], values as written in the `.txt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SnapshotNote {
    pub kind: NoteKind,
    pub start: i32,
    pub length: i32,
    pub pitch: i32,
    pub text: String,
}

/// How Players sang a round. Only `normal` in v1; party and team modes come
/// later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RoundMode {
    Normal,
}

/// How a round ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RoundEnd {
    /// The Song reached `#END` or the end of its audio.
    Played,
    /// End stopped it; the results screen still shows.
    Ended,
    /// Skip: no results screen and no Score records.
    Skipped,
}

/// What a Player sang into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MicKind {
    LocalMic,
    Phone,
}

/// Who a Score record belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ScorePlayer {
    /// A Profile; its records are keyed by id, so a rename carries them.
    Profile { profile_id: ProfileId },
    /// A Guest, by name; the record's Party tells Guests of one name apart.
    Guest { name: String },
}

/// The Beats a Score covers, both ends included. The whole Voice in v1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BeatRange {
    pub first_beat: i32,
    pub last_beat: i32,
}

impl BeatRange {
    /// How many Beats the range covers; 0 when `last_beat < first_beat`.
    pub fn len(self) -> usize {
        usize::try_from(i64::from(self.last_beat) - i64::from(self.first_beat) + 1).unwrap_or(0)
    }

    /// Whether the range covers no Beat.
    pub fn is_empty(self) -> bool {
        self.len() == 0
    }
}

/// One seated Player's Score as the Stage reports it with a round's outcome.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlayerScore {
    pub player: ScorePlayer,
    /// The Voice sung: an index into the parsed Song's `voices` (0 = `P1`).
    pub voice: u32,
    pub difficulty: Difficulty,
    /// The total, 0 to 10000; always `notes + golden + line_bonus`.
    pub total: u32,
    /// The Notes part, adjusted as on the results screen.
    pub notes: u32,
    /// The golden part, adjusted as on the results screen.
    pub golden: u32,
    /// The Line bonus part, adjusted as on the results screen.
    pub line_bonus: u32,
    pub mic_kind: MicKind,
    /// The Score is not Finished.
    pub unfinished: bool,
    /// The Player's Mic was lost at some moment during the Song.
    pub mic_lost: bool,
    pub beat_range: BeatRange,
    /// The value of every Beat in `beat_range`, in order.
    pub beat_values: Vec<BeatValue>,
}

/// Body of `POST /api/rounds`: how a round ended and, unless it was
/// skipped, one Score per seated Player (any number of them).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RoundOutcome {
    /// The Song as the Stage loaded it.
    pub song_id: SongId,
    /// The fingerprint the loaded Song carried.
    pub note_fingerprint: NoteFingerprint,
    pub party_id: PartyId,
    pub mode: RoundMode,
    /// When the Song last started from its beginning (after the last
    /// Restart), in milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub started_at_ms: i64,
    pub ended: RoundEnd,
    /// Empty for a skipped round.
    pub scores: Vec<PlayerScore>,
}

/// Names one stored round.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RoundId(#[ts(type = "number")] pub i64);

/// Names one stored Score record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScoreRecordId(#[ts(type = "number")] pub i64);

/// A stored round: one Song sung together, and its Score records.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StoredRound {
    pub id: RoundId,
    pub song: SongIdentity,
    pub party_id: PartyId,
    pub mode: RoundMode,
    #[ts(type = "number")]
    pub started_at_ms: i64,
    pub ended: RoundEnd,
    /// Groups the rounds of one game; always `null` in v1.
    pub game_id: Option<String>,
    /// The round's Score records, in the order the Stage sent them.
    pub records: Vec<ScoreRecord>,
}

/// One Player's kept performance of one round.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScoreRecord {
    pub id: ScoreRecordId,
    pub round_id: RoundId,
    pub party_id: PartyId,
    pub song: SongIdentity,
    pub player: ScorePlayer,
    pub voice: u32,
    pub difficulty: Difficulty,
    /// When the record was stored, in milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub recorded_at_ms: i64,
    pub total: u32,
    pub notes: u32,
    pub golden: u32,
    pub line_bonus: u32,
    pub mic_kind: MicKind,
    pub mode: RoundMode,
    pub unfinished: bool,
    pub mic_lost: bool,
    pub beat_range: BeatRange,
    pub note_fingerprint: NoteFingerprint,
    pub beat_values: Vec<BeatValue>,
    /// The record became its Profile's High score for this (Song, Voice,
    /// Difficulty) when it was stored: it counts (see [`HighScoreTable`]) and
    /// its total is strictly higher than every earlier counted record of the
    /// Profile there, or there was none. Never set for a Guest.
    pub new_high_score: bool,
}

/// One table of a Song's High scores: one (Song identity, Voice,
/// Difficulty). A record counts only when it belongs to a Profile, is
/// Finished (not unfinished), has a total above 0 and is in `normal` mode; a
/// mic lost record counts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HighScoreTable {
    /// The Voice: an index into the parsed Song's `voices` (0 = `P1`).
    pub voice: u32,
    pub difficulty: Difficulty,
    /// The top 10 Profiles, best first, each once with its best counted
    /// record; empty when no record counts.
    pub entries: Vec<HighScoreEntry>,
}

/// One Profile's High score in a [`HighScoreTable`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HighScoreEntry {
    /// 1-based. Equal totals share a place and the next place skips
    /// (1, 1, 3).
    pub place: u32,
    pub holder: HighScoreHolder,
    pub total: u32,
    /// The record was sung against another Note fingerprint than the
    /// Song's current one (an older timing).
    pub older_timing: bool,
}

/// The Profile holding a High score, as tables and Song rows show it:
/// outside any Party, so with its favourite colour.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HighScoreHolder {
    pub profile_id: ProfileId,
    pub name: String,
    pub avatar: Avatar,
    pub favourite_colour: PaletteKey,
}

/// A Song's top High score at any Difficulty and either Voice, for its row
/// in the Song list. Of equal totals, the one set first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TopHighScore {
    pub holder: HighScoreHolder,
    pub total: u32,
}

/// The answer to `GET /api/songs/{id}/high-scores`: one table per Voice of
/// the Song and Difficulty (Voice 0 first; Easy, Medium, Hard), empty ones
/// included, so a duet always has its two Voices' tables.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SongHighScores {
    pub tables: Vec<HighScoreTable>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(value: BeatValue) -> String {
        serde_json::to_string(&value).unwrap()
    }

    #[test]
    fn beat_values_on_the_wire() {
        assert_eq!(wire(BeatValue::NoVoice), r#"{"kind":"noVoice"}"#);
        assert_eq!(
            wire(BeatValue::VoiceWithoutPitch),
            r#"{"kind":"voiceWithoutPitch"}"#
        );
        assert_eq!(
            wire(BeatValue::Pitch { pitch: 57.25 }),
            r#"{"kind":"pitch","pitch":57.25}"#
        );
    }

    #[test]
    fn beat_values_round_trip() {
        for value in [
            BeatValue::NoVoice,
            BeatValue::VoiceWithoutPitch,
            BeatValue::Pitch {
                pitch: 61.123_456_789,
            },
        ] {
            let back: BeatValue = serde_json::from_str(&wire(value)).unwrap();
            assert_eq!(back, value);
        }
    }
}
