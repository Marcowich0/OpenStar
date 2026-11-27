//! Profile stats (`GET /api/profiles/{id}/stats`): what a Profile has sung,
//! computed from its Score records on a blocking thread.
//!
//! Only a Profile's own records are read, so a Guest's never count. Records
//! are keyed by Song identity, never a Library row, so a Song that has left
//! the Library still counts: it is named by the artist and title stored
//! with its latest round.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use openstar_protocol::UserMessage;
use openstar_protocol::library::SongIdentity;
use openstar_protocol::profile::{
    BestScore, Difficulty, HeldHighScore, MostSungSong, ProfileId, ProfileStats, StatsSong, SungAt,
};
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::scores::counted;
use crate::{AppState, library, profiles};

/// How many Songs `mostSung` lists.
pub const MOST_SUNG_LENGTH: usize = 5;

/// The stats of Profile `id`; `None` when no Profile has that id.
pub(crate) fn stats(conn: &Connection, id: ProfileId) -> rusqlite::Result<Option<ProfileStats>> {
    if profiles::get_in(conn, id)?.is_none() {
        return Ok(None);
    }
    let mut songs = Songs::default();
    let (songs_sung, rounds, finished_rounds) = conn.query_row(
        "SELECT COUNT(DISTINCT song_identity), COUNT(DISTINCT round_id),
             COUNT(DISTINCT CASE WHEN NOT unfinished THEN round_id END)
         FROM score_records WHERE profile_id = ?1",
        [id.0],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(Some(ProfileStats {
        songs_sung,
        rounds,
        finished_rounds,
        best_per_difficulty: best_per_difficulty(conn, id, &mut songs)?,
        high_scores_held: high_scores_held(conn, id, &mut songs)?,
        most_sung: most_sung(conn, id, &mut songs)?,
        first_sung: sung_at(conn, id, Sung::First, &mut songs)?,
        last_sung: sung_at(conn, id, Sung::Latest, &mut songs)?,
    }))
}

/// The best counted record at each Difficulty, earliest of equal totals, in
/// the order Easy, Medium, Hard.
fn best_per_difficulty(
    conn: &Connection,
    id: ProfileId,
    songs: &mut Songs,
) -> rusqlite::Result<Vec<BestScore>> {
    let rows = conn
        .prepare(concat!(
            "SELECT difficulty, total, song_identity, recorded_at_ms FROM (
                 SELECT *, ROW_NUMBER() OVER (PARTITION BY difficulty ORDER BY total DESC, id)
                     AS best
                 FROM score_records r WHERE r.profile_id = ?1 AND ",
            counted!("r"),
            "
             ) WHERE best = 1"
        ))?
        .query_map([id.0], |row| {
            Ok((
                difficulty(row, 0)?,
                row.get::<_, u32>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut best = Vec::with_capacity(rows.len());
    for wanted in [Difficulty::Easy, Difficulty::Medium, Difficulty::Hard] {
        for (difficulty, total, identity, recorded_at) in &rows {
            if *difficulty == wanted {
                best.push(BestScore {
                    difficulty: *difficulty,
                    total: *total,
                    song: songs.get(conn, identity)?,
                    recorded_at: *recorded_at,
                });
            }
        }
    }
    Ok(best)
}

/// Every (Song identity, Voice, Difficulty) whose High score table the
/// Profile heads: its best counted total there, and no other Profile's
/// counted record higher (equal totals share place 1, as in the tables).
/// Highest total first, then the earliest set.
fn high_scores_held(
    conn: &Connection,
    id: ProfileId,
    songs: &mut Songs,
) -> rusqlite::Result<Vec<HeldHighScore>> {
    let rows = conn
        .prepare(concat!(
            "SELECT song_identity, voice, difficulty, total FROM (
                 SELECT song_identity, voice, difficulty, total, id,
                     ROW_NUMBER() OVER (
                         PARTITION BY song_identity, voice, difficulty ORDER BY total DESC, id
                     ) AS best
                 FROM score_records r WHERE r.profile_id = ?1 AND ",
            counted!("r"),
            "
             ) m
             WHERE m.best = 1 AND NOT EXISTS (
                 SELECT 1 FROM score_records o
                 WHERE o.song_identity = m.song_identity AND o.voice = m.voice
                     AND o.difficulty = m.difficulty AND o.total > m.total AND ",
            counted!("o"),
            "
             )
             ORDER BY m.total DESC, m.id"
        ))?
        .query_map([id.0], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u32>(1)?,
                difficulty(row, 2)?,
                row.get::<_, u32>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(identity, voice, difficulty, total)| {
            Ok(HeldHighScore {
                song: songs.get(conn, &identity)?,
                voice,
                difficulty,
                total,
            })
        })
        .collect()
}

/// The Songs sung in the most rounds, then the most recently sung.
fn most_sung(
    conn: &Connection,
    id: ProfileId,
    songs: &mut Songs,
) -> rusqlite::Result<Vec<MostSungSong>> {
    let rows = conn
        .prepare(
            "SELECT song_identity, COUNT(DISTINCT round_id) AS rounds FROM score_records
             WHERE profile_id = ?1
             GROUP BY song_identity
             ORDER BY rounds DESC, MAX(id) DESC
             LIMIT ?2",
        )?
        .query_map(
            params![id.0, i64::try_from(MOST_SUNG_LENGTH).unwrap_or(i64::MAX)],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(identity, rounds)| {
            Ok(MostSungSong {
                song: songs.get(conn, &identity)?,
                rounds,
            })
        })
        .collect()
}

/// Which of a Profile's Score records [`sung_at`] takes.
#[derive(Clone, Copy)]
enum Sung {
    First,
    Latest,
}

/// The Profile's first or latest Score record.
fn sung_at(
    conn: &Connection,
    id: ProfileId,
    which: Sung,
    songs: &mut Songs,
) -> rusqlite::Result<Option<SungAt>> {
    let sql = match which {
        Sung::First => {
            "SELECT song_identity, recorded_at_ms FROM score_records
             WHERE profile_id = ?1 ORDER BY id ASC LIMIT 1"
        }
        Sung::Latest => {
            "SELECT song_identity, recorded_at_ms FROM score_records
             WHERE profile_id = ?1 ORDER BY id DESC LIMIT 1"
        }
    };
    let row = conn
        .query_row(sql, [id.0], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .optional()?;
    row.map(|(identity, at)| {
        Ok(SungAt {
            song: songs.get(conn, &identity)?,
            at,
        })
    })
    .transpose()
}

fn difficulty(row: &Row<'_>, column: usize) -> rusqlite::Result<Difficulty> {
    let key: String = row.get(column)?;
    Difficulty::from_key(&key).ok_or_else(|| profiles::unknown(column, "Difficulty", &key))
}

/// Each Song identity named once per request.
#[derive(Default)]
struct Songs(HashMap<String, StatsSong>);

impl Songs {
    /// The Song with identity key `key`: as the Library lists it now, else
    /// by the artist and title stored with its latest round that has them,
    /// else by the USDB mirror's or the identity's own.
    fn get(&mut self, conn: &Connection, key: &str) -> rusqlite::Result<StatsSong> {
        if let Some(song) = self.0.get(key) {
            return Ok(song.clone());
        }
        let identity: SongIdentity = serde_json::from_str(key).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
        })?;
        let tile_colour = library::tile_colour(&identity);
        let song = match library::preferred_copy(conn, key)? {
            Some(copy) => StatsSong {
                id: Some(copy.id),
                artist: copy.artist,
                title: copy.title,
                cover: copy.cover,
                tile_colour,
            },
            None => {
                let (artist, title) = stored_names(conn, key, &identity)?;
                StatsSong {
                    id: None,
                    artist,
                    title,
                    cover: None,
                    tile_colour,
                }
            }
        };
        self.0.insert(key.to_owned(), song.clone());
        Ok(song)
    }
}

/// The artist and title of a Song no longer in the Library.
fn stored_names(
    conn: &Connection,
    key: &str,
    identity: &SongIdentity,
) -> rusqlite::Result<(String, String)> {
    let stored = conn
        .query_row(
            "SELECT artist, title FROM rounds
             WHERE song_identity = ?1 AND artist IS NOT NULL AND title IS NOT NULL
             ORDER BY id DESC LIMIT 1",
            [key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some(names) = stored {
        return Ok(names);
    }
    match identity {
        SongIdentity::Usdb { usdb_id } => Ok(conn
            .query_row(
                "SELECT artist, title FROM usdb_songs WHERE usdb_id = ?1",
                [usdb_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .unwrap_or_default()),
        SongIdentity::ArtistTitle { artist, title, .. } => Ok((artist.clone(), title.clone())),
    }
}

/// `GET /api/profiles/{id}/stats`.
pub(crate) async fn profile_stats(State(state): State<AppState>, Path(id): Path<u32>) -> Response {
    match state.db.call(move |conn| stats(conn, ProfileId(id))).await {
        Ok(Some(stats)) => Json(stats).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(UserMessage::ProfileNotFound)).into_response(),
        Err(error) => {
            tracing::error!(?error, "reading Profile stats");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(UserMessage::ServerError),
            )
                .into_response()
        }
    }
}
