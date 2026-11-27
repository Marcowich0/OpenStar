//! Keeping every performance: the Note fingerprint, rounds, Score records
//! and Note snapshots.
//!
//! The server never scores. The Stage sends a round's outcome
//! (`POST /api/rounds`); [`store_in`] keeps it in one transaction.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::library::{SongId, SongIdentity};
use openstar_protocol::party::{PartyId, RequestId};
use openstar_protocol::profile::{Difficulty, PaletteKey, ProfileId};
use openstar_protocol::scoring::{
    BeatRange, BeatValue, HighScoreEntry, HighScoreHolder, HighScoreTable, NoteFingerprint,
    NoteSnapshot, RoundEnd, RoundId, RoundOutcome, ScorePlayer, ScoreRecord, ScoreRecordId,
    SnapshotLine, SnapshotNote, SnapshotVoice, SongHighScores, StoredRound, TopHighScore,
};
use openstar_protocol::song::ParsedSong;
use openstar_protocol::{ChangeTopic, UserMessage};
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
        "INSERT INTO rounds (song_identity, party_id, mode, started_at_ms, ended, game_id,
             request_id, artist, title)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8)",
        params![
            identity,
            outcome.party_id.0,
            key(&outcome.mode),
            outcome.started_at_ms,
            key(&outcome.ended),
            outcome.request_id.0,
            song.song.headers.artist,
            song.song.headers.title,
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

/// The round stored for Request `request_id` of Party `party_id`, if one
/// is: a Request is sung at most once, so this is how the Stage's retry of
/// the same outcome finds what it already stored.
pub fn round_for_request(
    conn: &Connection,
    party_id: &PartyId,
    request_id: RequestId,
) -> rusqlite::Result<Option<StoredRound>> {
    let id: Option<i64> = conn
        .query_row(
            "SELECT id FROM rounds WHERE party_id = ?1 AND request_id = ?2",
            params![party_id.0, request_id.0],
            |row| row.get(0),
        )
        .optional()?;
    match id {
        Some(id) => round(conn, RoundId(id)),
        None => Ok(None),
    }
}

/// Points per Rank title band.
pub const RANK_TITLE_BAND_POINTS: u32 = 1250;

/// How many Rank titles there are; the last band runs to 10000.
pub const RANK_TITLE_BANDS: u8 = 8;

/// Which Rank title a total shows: `min(floor(total / 1250), 7)`.
pub fn rank_title_band(total: u32) -> u8 {
    u8::try_from(total / RANK_TITLE_BAND_POINTS)
        .unwrap_or(u8::MAX)
        .min(RANK_TITLE_BANDS - 1)
}

/// Each total's place, in the order given: 1 plus how many totals are
/// strictly higher, so equal totals share a place and the next place skips
/// (1, 1, 3).
pub fn places(totals: &[u32]) -> Vec<u32> {
    totals
        .iter()
        .map(|total| {
            let higher = totals.iter().filter(|other| *other > total).count();
            u32::try_from(higher + 1).unwrap_or(u32::MAX)
        })
        .collect()
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

/// The SQL condition under which a record of `score_records` (named by
/// `alias`) counts toward High scores: a Profile's, Finished, above 0, in
/// `normal` mode. A mic lost record counts. A Voice without scored Notes
/// always scores 0, so it never counts.
macro_rules! counted {
    ($alias:literal) => {
        concat!(
            $alias,
            ".profile_id IS NOT NULL AND NOT ",
            $alias,
            ".unfinished AND ",
            $alias,
            ".total > 0 AND ",
            $alias,
            ".mode = 'normal'"
        )
    };
}
pub(crate) use counted;

/// The "new high score" flag of record `r`, as SQL: it counts, and its total
/// is strictly higher than every earlier counted record (lower id) of its
/// Profile for the same (Song identity, Voice, Difficulty). Earlier records
/// never change, so the flag is the one decided when `r` was stored, and it
/// is computed from the records instead of being a second copy.
const NEW_HIGH_SCORE: &str = concat!(
    "(",
    counted!("r"),
    " AND r.total > COALESCE((SELECT MAX(e.total) FROM score_records e
         WHERE e.song_identity = r.song_identity AND e.profile_id = r.profile_id
         AND e.voice = r.voice AND e.difficulty = r.difficulty AND e.id < r.id AND ",
    counted!("e"),
    "), 0))"
);

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
        .prepare(&format!(
            "SELECT id, round_id, party_id, song_identity, profile_id, guest_name, voice,
                 difficulty, recorded_at_ms, total, notes, golden, line_bonus, mic_kind, mode,
                 unfinished, mic_lost, first_beat, last_beat, note_fingerprint, beat_values,
                 {NEW_HIGH_SCORE}
             FROM score_records r WHERE round_id = ?1 ORDER BY id"
        ))?
        .query_map([id.0], read_record)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(round))
}

/// Every Difficulty, in the order tables are listed.
const DIFFICULTIES: [Difficulty; 3] = [Difficulty::Easy, Difficulty::Medium, Difficulty::Hard];

/// How many Profiles a High score table shows.
pub const HIGH_SCORE_TABLE_LENGTH: usize = 10;

/// The High score tables of the Song with `identity`, `voices` Voices and
/// current fingerprint `current`: one per Voice and Difficulty. Records
/// show only through a Song in the Library, so the caller looks the Song up
/// first; a Song that left the Library has no tables to ask for.
pub fn high_score_tables(
    conn: &Connection,
    identity: &SongIdentity,
    voices: u32,
    current: &NoteFingerprint,
) -> rusqlite::Result<SongHighScores> {
    let mut statement = conn.prepare_cached(concat!(
        "SELECT r.profile_id, p.name, p.avatar_kind, p.avatar_ref, p.favourite_colour,
             r.total, r.note_fingerprint
         FROM (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY profile_id ORDER BY total DESC, id)
                 AS best
             FROM score_records r
             WHERE song_identity = ?1 AND voice = ?2 AND difficulty = ?3 AND ",
        counted!("r"),
        "
         ) r
         JOIN profiles p ON p.id = r.profile_id
         WHERE r.best = 1
         ORDER BY r.total DESC, r.id
         LIMIT ?4"
    ))?;
    let key = library::identity_key(identity);
    let length = i64::try_from(HIGH_SCORE_TABLE_LENGTH).unwrap_or(i64::MAX);
    let mut tables = Vec::new();
    for voice in 0..voices {
        for difficulty in DIFFICULTIES {
            let rows = statement
                .query_map(params![key, voice, difficulty.as_str(), length], |row| {
                    let fingerprint: String = row.get(6)?;
                    Ok((
                        read_holder(row, 0)?,
                        row.get::<_, u32>(5)?,
                        fingerprint != current.0,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut entries: Vec<HighScoreEntry> = Vec::with_capacity(rows.len());
            for (n, (holder, total, older_timing)) in rows.into_iter().enumerate() {
                let place = match entries.last() {
                    Some(previous) if previous.total == total => previous.place,
                    _ => u32::try_from(n + 1).unwrap_or(u32::MAX),
                };
                entries.push(HighScoreEntry {
                    place,
                    holder,
                    total,
                    older_timing,
                });
            }
            tables.push(HighScoreTable {
                voice,
                difficulty,
                entries,
            });
        }
    }
    Ok(SongHighScores { tables })
}

/// The top High score of every Song identity that has one, by identity key
/// (`library::identity_key`): the highest counted record at any Difficulty
/// and Voice, the earliest of equal totals. Identities not in the Library
/// are included; the Song list only asks for the Songs it lists.
pub(crate) fn top_high_scores(
    conn: &Connection,
) -> rusqlite::Result<HashMap<String, TopHighScore>> {
    let mut statement = conn.prepare_cached(concat!(
        "SELECT r.profile_id, p.name, p.avatar_kind, p.avatar_ref, p.favourite_colour,
             r.total, r.song_identity
         FROM (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY song_identity ORDER BY total DESC, id)
                 AS top
             FROM score_records r WHERE ",
        counted!("r"),
        "
         ) r
         JOIN profiles p ON p.id = r.profile_id
         WHERE r.top = 1"
    ))?;
    statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(6)?,
                TopHighScore {
                    holder: read_holder(row, 0)?,
                    total: row.get(5)?,
                },
            ))
        })?
        .collect()
}

/// A [`HighScoreHolder`] from columns `first..first + 5`: Profile id, name,
/// avatar kind and reference, favourite colour.
fn read_holder(row: &Row<'_>, first: usize) -> rusqlite::Result<HighScoreHolder> {
    let colour: String = row.get(first + 4)?;
    Ok(HighScoreHolder {
        profile_id: ProfileId(row.get(first)?),
        name: row.get(first + 1)?,
        avatar: profiles::read_avatar(row, first + 2)?,
        favourite_colour: PaletteKey::from_key(&colour)
            .ok_or_else(|| profiles::unknown(first + 4, "palette key", &colour))?,
    })
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
        new_high_score: row.get(21)?,
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
    /// The Song is not playing in the current Party (it was never started,
    /// the Stage dropped, the server restarted, or another Party's outcome).
    NotPlaying,
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (
                StatusCode::UNPROCESSABLE_ENTITY,
                UserMessage::InvalidMessage,
            ),
            Self::SongGone => (StatusCode::NOT_FOUND, UserMessage::SongNotInLibrary),
            Self::SongChanged => (StatusCode::CONFLICT, UserMessage::SongNotInLibrary),
            Self::ProfileNotFound => (StatusCode::NOT_FOUND, UserMessage::ProfileNotFound),
            Self::NotPlaying => (StatusCode::CONFLICT, UserMessage::NoSongPlaying),
        };
        (status, Json(message)).into_response()
    }
}

/// `POST /api/rounds`: the Stage's outcome of the Song that just ended.
/// The live-state task checks it is the current Party's playing Song (any
/// Song for a skip), stores it in one transaction and, unless it was a
/// skip, shows its results to the Party. Answers `201` with the round as
/// stored and the results. The same Request's outcome sent again (a retry
/// after a lost response) is stored once: the answer is the same.
pub(crate) async fn store_round(
    State(state): State<AppState>,
    Json(outcome): Json<RoundOutcome>,
) -> Response {
    let now = state.clock.now_millis();
    match state.live.finish_round(outcome, now).await {
        Ok(Ok(stored)) => {
            if !stored.round.records.is_empty() {
                // Song rows, High score tables and the Profiles' last sung
                // may have changed.
                state
                    .live
                    .changed(vec![ChangeTopic::Library, ChangeTopic::Profiles])
                    .await;
            }
            (StatusCode::CREATED, Json(stored)).into_response()
        }
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

/// `POST /api/test/rounds` (test routes only): stores an outcome as it
/// comes, with no Party, Song or seat checks, and answers `201` with the
/// round as stored. For tests of storing and High scores.
pub(crate) async fn store_round_test(
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
        Ok(Ok(round)) => {
            if !round.records.is_empty() {
                state.live.changed(vec![ChangeTopic::Library]).await;
            }
            (StatusCode::CREATED, Json(round)).into_response()
        }
        Ok(Err(refused)) => refused.into_response(),
        Err(error) => {
            tracing::error!(?error, "storing a round");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// `GET /api/songs/{id}/high-scores`: the playable Song's High score
/// tables; `404` for any other id.
pub(crate) async fn song_high_scores(
    State(state): State<AppState>,
    Path(id): Path<u32>,
) -> Response {
    let tables = state
        .db
        .call(move |conn| {
            let Some(song) = library::song_detail(conn, SongId(id))? else {
                return Ok(None);
            };
            let voices = u32::try_from(song.song.voices.len()).unwrap_or(u32::MAX);
            high_score_tables(conn, &song.identity, voices, &song.note_fingerprint).map(Some)
        })
        .await;
    match tables {
        Ok(Some(tables)) => Json(tables).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(?error, "reading High scores");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
