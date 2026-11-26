//! Searching the USDB mirror (`GET /api/usdb/songs`). It reads SQLite only,
//! so a search never costs USDB a request, and it sees whatever is mirrored
//! so far while the mirror fills.
//!
//! Matching is the Library search's (`library::search`): every word of the
//! search must appear in the artist or the title, both sides folded with
//! `identity::normalise`. The mirror stores each row's folded artist and
//! title (`artist_key`, `title_key`), so the match runs in SQL over tens of
//! thousands of rows.

use openstar_protocol::library::SongIdentity;
use openstar_protocol::usdb::{
    USDB_SEARCH_LIMIT, UsdbSearchQuery, UsdbSearchResults, UsdbSong, UsdbSort,
};
use rusqlite::{Connection, params, params_from_iter};

use crate::library::{identity_present, normalise, tile_colour};

/// The songs matching `query`, at most [`USDB_SEARCH_LIMIT`], and how many
/// matched.
pub(crate) fn search(
    conn: &mut Connection,
    query: &UsdbSearchQuery,
) -> rusqlite::Result<UsdbSearchResults> {
    fold_unfolded(conn)?;
    let words: Vec<String> = query
        .search
        .as_deref()
        .map(normalise)
        .unwrap_or_default()
        .split(' ')
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect();
    let condition = if words.is_empty() {
        "1".to_owned()
    } else {
        (1..=words.len())
            .map(|i| format!("(instr(artist_key, ?{i}) > 0 OR instr(title_key, ?{i}) > 0)"))
            .collect::<Vec<_>>()
            .join(" AND ")
    };
    let order = match query.sort.unwrap_or_default() {
        UsdbSort::Rating => "rating DESC, views DESC, usdb_id",
        UsdbSort::Views => "views DESC, rating DESC, usdb_id",
    };
    let total: u32 = conn.query_row(
        &format!("SELECT COUNT(*) FROM usdb_songs WHERE {condition}"),
        params_from_iter(&words),
        |row| row.get(0),
    )?;
    let mut select = conn.prepare(&format!(
        "SELECT usdb_id, artist, title, genre, year, edition, golden, language, creator,
             rating, views
         FROM usdb_songs WHERE {condition} ORDER BY {order} LIMIT {USDB_SEARCH_LIMIT}"
    ))?;
    let rows = select
        .query_map(params_from_iter(&words), |row| {
            let usdb_id: u32 = row.get(0)?;
            let identity = SongIdentity::Usdb { usdb_id };
            Ok(UsdbSong {
                usdb_id,
                artist: row.get(1)?,
                title: row.get(2)?,
                genre: row.get(3)?,
                year: row.get(4)?,
                edition: row.get(5)?,
                golden: row.get(6)?,
                language: row.get(7)?,
                creator: row.get(8)?,
                #[expect(clippy::cast_possible_truncation, reason = "0 to 5 in halves")]
                rating: row.get::<_, f64>(9)? as f32,
                views: row.get(10)?,
                in_library: false,
                cover: format!("/api/usdb/songs/{usdb_id}/cover"),
                tile_colour: tile_colour(&identity),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(select);
    let songs = rows
        .into_iter()
        .map(|song| {
            let identity = SongIdentity::Usdb {
                usdb_id: song.usdb_id,
            };
            Ok(UsdbSong {
                in_library: identity_present(conn, &identity)?,
                ..song
            })
        })
        .collect::<rusqlite::Result<_>>()?;
    Ok(UsdbSearchResults { songs, total })
}

/// Folds the artist and title of rows stored before the mirror folded them
/// (a mirror from before migration 26). A no-op once every row is folded.
fn fold_unfolded(conn: &mut Connection) -> rusqlite::Result<()> {
    let unfolded: Vec<(u32, String, String)> = conn
        .prepare_cached(
            "SELECT usdb_id, artist, title FROM usdb_songs
             WHERE artist_key IS NULL OR title_key IS NULL",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if unfolded.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    {
        let mut update = tx.prepare_cached(
            "UPDATE usdb_songs SET artist_key = ?2, title_key = ?3 WHERE usdb_id = ?1",
        )?;
        for (id, artist, title) in unfolded {
            update.execute(params![id, normalise(&artist), normalise(&title)])?;
        }
    }
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mirror_with(rows: &[(u32, &str, &str, f64, u32)]) -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        for (id, artist, title, rating, views) in rows {
            conn.execute(
                "INSERT INTO usdb_songs (usdb_id, artist, title, genre, edition, golden,
                     language, creator, rating, views, last_change, refetch)
                 VALUES (?1, ?2, ?3, '', '', 0, '', '', ?4, ?5, 0, 0)",
                params![id, artist, title, rating, views],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn rows_stored_before_folding_are_folded_by_the_first_search() {
        let mut conn = mirror_with(&[(1, "Café Band", "ÉTÉ", 3.0, 1)]);
        let query = UsdbSearchQuery {
            search: Some("cafe".to_owned()),
            sort: None,
        };
        // NFKC plus case folding: "Café" folds to "café", not "cafe".
        assert_eq!(search(&mut conn, &query).unwrap().total, 0);
        let query = UsdbSearchQuery {
            search: Some("CAFÉ été".to_owned()),
            sort: None,
        };
        assert_eq!(search(&mut conn, &query).unwrap().total, 1);
    }

    #[test]
    fn a_word_with_sql_wildcards_matches_only_itself() {
        let mut conn = mirror_with(&[(1, "100% Band", "a_b", 3.0, 1), (2, "Other", "axb", 3.0, 1)]);
        let query = |search: &str| UsdbSearchQuery {
            search: Some(search.to_owned()),
            sort: None,
        };
        assert_eq!(search(&mut conn, &query("a_b")).unwrap().total, 1);
        assert_eq!(search(&mut conn, &query("%")).unwrap().total, 1);
    }

    #[test]
    fn ties_sort_by_the_other_value_then_by_id() {
        let mut conn = mirror_with(&[
            (3, "A", "x", 4.0, 10),
            (1, "B", "x", 4.0, 10),
            (2, "C", "x", 4.0, 20),
        ]);
        let mut ids = |sort| {
            search(
                &mut conn,
                &UsdbSearchQuery {
                    search: None,
                    sort: Some(sort),
                },
            )
            .unwrap()
            .songs
            .iter()
            .map(|s| s.usdb_id)
            .collect::<Vec<_>>()
        };
        assert_eq!(ids(UsdbSort::Rating), [2, 1, 3]);
    }
}
