//! Keeping every performance: the Note fingerprint, rounds, Score records
//! and Note snapshots.
//!
//! The server never scores. The Stage sends a round's outcome
//! (`POST /api/rounds`); [`store_in`] keeps it in one transaction.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::UserMessage;
use openstar_protocol::library::SongIdentity;
use openstar_protocol::party::PartyId;
use openstar_protocol::profile::{Difficulty, ProfileId};
use openstar_protocol::scoring::{
    BeatRange, BeatValue, NoteFingerprint, NoteSnapshot, RoundEnd, RoundId, RoundOutcome,
    ScorePlayer, ScoreRecord, ScoreRecordId, SnapshotLine, SnapshotNote, SnapshotVoice,
    StoredRound,
};
use openstar_protocol::song::ParsedSong;
use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};

use crate::{AppState, library, profiles};

/// The note content of `song` that its [`NoteFingerprint`] covers: `#GAP`,
/// `#BPM` and every Voice's Lines and Notes, nothing from the file's bytes.
pub fn note_snapshot(song: &ParsedSong) -> NoteSnapshot {
    NoteSnapshot {
        gap_seconds: song.headers.gap_seconds,
        beats_per_minute: song.headers.beats_per_minute,
        voices: song
            .voices
            .iter()
            .map(|voice| SnapshotVoice {
                lines: voice
                    .lines
                    .iter()
                    .map(|line| SnapshotLine {
                        notes: line
                            .notes
                            .iter()
                            .map(|note| SnapshotNote {
                                kind: note.kind,
                                start: note.start,
                                length: note.length,
                                pitch: note.pitch,
                                text: note.text.clone(),
                            })
                            .collect(),
                        end: line.end.as_ref().map(|end| end.beat),
                    })
                    .collect(),
            })
            .collect(),
    }
}

/// The Note fingerprint of `song`.
pub fn note_fingerprint(song: &ParsedSong) -> NoteFingerprint {
    fingerprint_of(&note_snapshot(song))
}

/// The fingerprint of a snapshot: SHA-256 of its JSON, whose field order is
/// fixed by the type, so equal content always hashes the same.
pub fn fingerprint_of(snapshot: &NoteSnapshot) -> NoteFingerprint {
    let json = serde_json::to_vec(snapshot).expect("a Note snapshot encodes");
    let digest = Sha256::digest(&json);
    NoteFingerprint(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Stores a round's outcome inside the caller's transaction: the round row,
/// one Score record per Player in the order sent, and the Note snapshot if
/// its fingerprint is new. A Profile's record also sets its last Difficulty
/// and last sung. A refusal leaves rows behind in `tx`, so the caller must
/// not commit it.
pub(crate) fn store_in(
    tx: &Connection,
    outcome: &RoundOutcome,
    now_ms: i64,
) -> rusqlite::Result<Result<StoredRound, Refused>> {
    if let Err(refused) = check(outcome) {
        return Ok(Err(refused));
    }
    let Some(song) = library::song_detail(tx, outcome.song_id)? else {
        return Ok(Err(Refused::SongGone));
    };
    if !outcome.scores.is_empty() {
        if song.note_fingerprint != outcome.note_fingerprint {
            return Ok(Err(Refused::SongChanged));
        }
        let voices = song.song.voices.len();
        if outcome
            .scores
            .iter()
            .any(|score| usize::try_from(score.voice).map_or(true, |voice| voice >= voices))
        {
            return Ok(Err(Refused::Invalid));
        }
    }
    let identity = library::identity_key(&song.identity);
    tx.execute(
        "INSERT INTO rounds (song_identity, party_id, mode, started_at_ms, ended, game_id)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
        params![
            identity,
            outcome.party_id.0,
            key(&outcome.mode),
            outcome.started_at_ms,
            key(&outcome.ended),
        ],
    )?;
    let round_id = RoundId(tx.last_insert_rowid());
    if !outcome.scores.is_empty() {
        let snapshot = note_snapshot(&song.song);
        tx.execute(
            "INSERT OR IGNORE INTO note_snapshots (fingerprint, snapshot) VALUES (?1, ?2)",
            params![
                fingerprint_of(&snapshot).0,
                serde_json::to_string(&snapshot).expect("a Note snapshot encodes"),
            ],
        )?;
    }
    for score in &outcome.scores {
        let (profile_id, guest_name) = match &score.player {
            ScorePlayer::Profile { profile_id } => {
                if !profiles::record_sung_in(tx, *profile_id, score.difficulty, now_ms)? {
                    return Ok(Err(Refused::ProfileNotFound));
                }
                (Some(profile_id.0), None)
            }
            ScorePlayer::Guest { name } => (None, Some(name.trim())),
        };
        tx.execute(
            "INSERT INTO score_records (round_id, party_id, song_identity, profile_id,
                 guest_name, voice, difficulty, recorded_at_ms, total, notes, golden,
                 line_bonus, mic_kind, mode, unfinished, mic_lost, first_beat, last_beat,
                 note_fingerprint, beat_values)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 ?16, ?17, ?18, ?19, ?20)",
            params![
                round_id.0,
                outcome.party_id.0,
                identity,
                profile_id,
                guest_name,
                score.voice,
                score.difficulty.as_str(),
                now_ms,
                score.total,
                score.notes,
                score.golden,
                score.line_bonus,
                key(&score.mic_kind),
                key(&outcome.mode),
                score.unfinished,
                score.mic_lost,
                score.beat_range.first_beat,
                score.beat_range.last_beat,
                outcome.note_fingerprint.0,
                encode_beat_values(&score.beat_values),
            ],
        )?;
    }
    let stored = round(tx, round_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    Ok(Ok(stored))
}

/// The checks that need no database: a skipped round has no Scores, and
/// each Score fills its Beat range, adds up, and names a Guest by a name.
fn check(outcome: &RoundOutcome) -> Result<(), Refused> {
    if outcome.ended == RoundEnd::Skipped && !outcome.scores.is_empty() {
        return Err(Refused::Invalid);
    }
    for score in &outcome.scores {
        let range = score.beat_range;
        let parts = u64::from(score.notes) + u64::from(score.golden) + u64::from(score.line_bonus);
        let named = match &score.player {
            ScorePlayer::Profile { .. } => true,
            ScorePlayer::Guest { name } => !name.trim().is_empty(),
        };
        if range.is_empty()
            || score.beat_values.len() != range.len()
            || parts != u64::from(score.total)
            || !named
        {
            return Err(Refused::Invalid);
        }
    }
    Ok(())
}

/// Moves every round and Score record of Song identity `from` to `to`,
/// inside the caller's transaction: the Library's identity move when
/// OpenStar's own edit changes a Song's identity key. Returns how many Score
/// records moved.
pub fn move_identity_in(
    conn: &Connection,
    from: &SongIdentity,
    to: &SongIdentity,
) -> rusqlite::Result<usize> {
    let (from, to) = (library::identity_key(from), library::identity_key(to));
    conn.execute(
        "UPDATE rounds SET song_identity = ?2 WHERE song_identity = ?1",
        params![from, to],
    )?;
    conn.execute(
        "UPDATE score_records SET song_identity = ?2 WHERE song_identity = ?1",
        params![from, to],
    )
}

/// Every stored round with its records, oldest first.
pub fn rounds(conn: &Connection) -> rusqlite::Result<Vec<StoredRound>> {
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM rounds ORDER BY id")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut rounds = Vec::with_capacity(ids.len());
    for id in ids {
        rounds.extend(round(conn, RoundId(id))?);
    }
    Ok(rounds)
}

/// The stored round `id` with its records, in the order they were sent.
pub fn round(conn: &Connection, id: RoundId) -> rusqlite::Result<Option<StoredRound>> {
    let Some(mut round) = conn
        .query_row(
            "SELECT id, song_identity, party_id, mode, started_at_ms, ended, game_id
             FROM rounds WHERE id = ?1",
            [id.0],
            |row| {
                Ok(StoredRound {
                    id: RoundId(row.get(0)?),
                    song: from_json(row, 1)?,
                    party_id: PartyId(row.get(2)?),
                    mode: from_key(row, 3)?,
                    started_at_ms: row.get(4)?,
                    ended: from_key(row, 5)?,
                    game_id: row.get(6)?,
                    records: Vec::new(),
                })
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    round.records = conn
        .prepare(
            "SELECT id, round_id, party_id, song_identity, profile_id, guest_name, voice,
                 difficulty, recorded_at_ms, total, notes, golden, line_bonus, mic_kind, mode,
                 unfinished, mic_lost, first_beat, last_beat, note_fingerprint, beat_values
             FROM score_records WHERE round_id = ?1 ORDER BY id",
        )?
        .query_map([id.0], read_record)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(round))
}

/// The Note snapshot stored for `fingerprint`, if one is.
pub fn stored_snapshot(
    conn: &Connection,
    fingerprint: &NoteFingerprint,
) -> rusqlite::Result<Option<NoteSnapshot>> {
    conn.query_row(
        "SELECT snapshot FROM note_snapshots WHERE fingerprint = ?1",
        [&fingerprint.0],
        |row| from_json(row, 0),
    )
    .optional()
}

fn read_record(row: &Row<'_>) -> rusqlite::Result<ScoreRecord> {
    let profile_id: Option<u32> = row.get(4)?;
    let player = match profile_id {
        Some(id) => ScorePlayer::Profile {
            profile_id: ProfileId(id),
        },
        None => ScorePlayer::Guest { name: row.get(5)? },
    };
    let difficulty: String = row.get(7)?;
    let blob: Vec<u8> = row.get(20)?;
    Ok(ScoreRecord {
        id: ScoreRecordId(row.get(0)?),
        round_id: RoundId(row.get(1)?),
        party_id: PartyId(row.get(2)?),
        song: from_json(row, 3)?,
        player,
        voice: row.get(6)?,
        difficulty: Difficulty::from_key(&difficulty)
            .ok_or_else(|| profiles::unknown(7, "Difficulty", &difficulty))?,
        recorded_at_ms: row.get(8)?,
        total: row.get(9)?,
        notes: row.get(10)?,
        golden: row.get(11)?,
        line_bonus: row.get(12)?,
        mic_kind: from_key(row, 13)?,
        mode: from_key(row, 14)?,
        unfinished: row.get(15)?,
        mic_lost: row.get(16)?,
        beat_range: BeatRange {
            first_beat: row.get(17)?,
            last_beat: row.get(18)?,
        },
        note_fingerprint: NoteFingerprint(row.get(19)?),
        beat_values: decode_beat_values(&blob).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                20,
                Type::Blob,
                "malformed Beat values".into(),
            )
        })?,
    })
}

const NO_VOICE: u8 = 0;
const VOICE_WITHOUT_PITCH: u8 = 1;
const PITCH: u8 = 2;

/// One byte per Beat, and a pitch's f64 bits after its byte, so every pitch
/// reads back exactly.
fn encode_beat_values(values: &[BeatValue]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(values.len() * 3);
    for value in values {
        match value {
            BeatValue::NoVoice => bytes.push(NO_VOICE),
            BeatValue::VoiceWithoutPitch => bytes.push(VOICE_WITHOUT_PITCH),
            BeatValue::Pitch { pitch } => {
                bytes.push(PITCH);
                bytes.extend_from_slice(&pitch.to_le_bytes());
            }
        }
    }
    bytes
}

fn decode_beat_values(mut bytes: &[u8]) -> Option<Vec<BeatValue>> {
    let mut values = Vec::new();
    while let Some((&tag, rest)) = bytes.split_first() {
        bytes = rest;
        values.push(match tag {
            NO_VOICE => BeatValue::NoVoice,
            VOICE_WITHOUT_PITCH => BeatValue::VoiceWithoutPitch,
            PITCH => {
                let (pitch, rest) = bytes.split_first_chunk::<8>()?;
                bytes = rest;
                BeatValue::Pitch {
                    pitch: f64::from_le_bytes(*pitch),
                }
            }
            _ => return None,
        });
    }
    Some(values)
}

/// The key a unit enum is sent and stored as, for example `"localMic"`.
fn key<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(key)) => key,
        _ => unreachable!("only unit enums are stored by key"),
    }
}

fn from_key<T: DeserializeOwned>(row: &Row<'_>, column: usize) -> rusqlite::Result<T> {
    let text: String = row.get(column)?;
    serde_json::from_value(serde_json::Value::String(text.clone()))
        .map_err(|_| profiles::unknown(column, "key", &text))
}

fn from_json<T: DeserializeOwned>(row: &Row<'_>, column: usize) -> rusqlite::Result<T> {
    let text: String = row.get(column)?;
    serde_json::from_str(&text)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(column, Type::Text, e.into()))
}

/// Why an outcome was not stored. Nothing of it is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refused {
    /// The outcome does not hold together (Scores with a Skip, Beat values
    /// that do not fill their range, parts that do not add up, a Voice the
    /// Song lacks, an empty Guest name).
    Invalid,
    /// The Song is not in the Library.
    SongGone,
    /// The Song's notes changed since the Stage loaded it, so the Notes the
    /// records were sung against are no longer known.
    SongChanged,
    /// A record names a Profile that does not exist.
    ProfileNotFound,
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (StatusCode::UNPROCESSABLE_ENTITY, UserMessage::InvalidMessage),
            Self::SongGone => (StatusCode::NOT_FOUND, UserMessage::SongNotInLibrary),
            Self::SongChanged => (StatusCode::CONFLICT, UserMessage::SongNotInLibrary),
            Self::ProfileNotFound => (StatusCode::NOT_FOUND, UserMessage::ProfileNotFound),
        };
        (status, Json(message)).into_response()
    }
}

/// `POST /api/rounds`: stores a round's outcome in one transaction and
/// answers `201` with the round as stored.
pub(crate) async fn store_round(
    State(state): State<AppState>,
    Json(outcome): Json<RoundOutcome>,
) -> Response {
    let now = state.clock.now_millis();
    let stored = state
        .db
        .call(move |conn| {
            let tx = conn.transaction()?;
            let stored = store_in(&tx, &outcome, now)?;
            if stored.is_ok() {
                tx.commit()?;
            }
            Ok(stored)
        })
        .await;
    match stored {
        Ok(Ok(round)) => (StatusCode::CREATED, Json(round)).into_response(),
        Ok(Err(refused)) => refused.into_response(),
        Err(error) => {
            tracing::error!(?error, "storing a round");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(UserMessage::ServerError),
            )
                .into_response()
        }
    }
}
