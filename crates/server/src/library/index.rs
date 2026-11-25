//! The Library index in SQLite: one row per candidate `.txt` (table
//! `library_files`).
//!
//! Each row keeps what the scan needs to skip an unchanged file (size, mtime,
//! parser version), the parse result (the parsed Song as JSON, or nothing
//! when the `.txt` is rejected, plus the parser's problems), the file
//! references the headers name, and what they resolved to at the last scan.
//! The references are resolved again at every scan, without re-reading the
//! `.txt`, so a media file added or removed later is noticed.

use super::identity;
use openstar_protocol::library::{
    LibraryProblem, ProblemReason, ProblemSeverity, SongDetail, SongId, SongIdentity, SongSummary,
};
use openstar_protocol::song::ParsedSong;
use rusqlite::{Connection, OptionalExtension, Transaction, params};

/// A problem as a row stores it.
pub(crate) type Problem = (ProblemSeverity, ProblemReason);

/// What a file reference is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    Audio,
    Video,
    Cover,
    Background,
    Vocals,
    Instrumental,
}

impl Role {
    pub(crate) const ALL: [Role; 6] = [
        Role::Audio,
        Role::Video,
        Role::Cover,
        Role::Background,
        Role::Vocals,
        Role::Instrumental,
    ];

    fn column(self) -> &'static str {
        match self {
            Role::Audio => "audio_path",
            Role::Video => "video_path",
            Role::Cover => "cover_path",
            Role::Background => "background_path",
            Role::Vocals => "vocals_path",
            Role::Instrumental => "instrumental_path",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Role::Audio => "audio",
            Role::Video => "video",
            Role::Cover => "cover",
            Role::Background => "background",
            Role::Vocals => "vocals",
            Role::Instrumental => "instrumental",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|role| role.name() == name)
    }
}

/// One file reference from a header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Reference {
    pub role: Role,
    /// The header key without `#`, upper-cased.
    pub header: &'static str,
    /// The value as written.
    pub value: String,
}

/// The references of a parsed `.txt`, and what each resolved to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Media {
    /// Every reference the headers name. Empty for a rejected `.txt`.
    pub references: Vec<Reference>,
    /// The problems the references cause (resolved again at every scan).
    pub problems: Vec<Problem>,
    /// The resolved file of each role, relative to the Library.
    pub resolved: Vec<(Role, String)>,
    /// `apiId` from the `metadata.json` beside the `.txt` (read again at
    /// every scan, with the references).
    pub usdb_id: Option<u32>,
}

/// A `.txt` just read, ready to be stored.
pub(crate) struct ReadFile {
    pub path: String,
    pub size: i64,
    pub mtime_ns: i64,
    /// The detected encoding's name; `None` when the file could not be read.
    pub encoding: Option<&'static str>,
    /// `None` when the `.txt` is rejected.
    pub song: Option<ParsedSong>,
    pub txt_problems: Vec<Problem>,
    pub media: Media,
}

/// What a scan needs to know about an indexed file.
pub(crate) struct Stored {
    pub id: i64,
    pub size: i64,
    pub mtime_ns: i64,
    pub parser_version: u32,
    /// Whether the `.txt` parsed (its references are then resolved again).
    pub parsed: bool,
    pub references: Vec<Reference>,
}

/// Every indexed file, by path.
pub(crate) fn load(conn: &Connection) -> rusqlite::Result<Vec<(String, Stored)>> {
    let mut statement = conn.prepare(
        "SELECT id, path, size, mtime_ns, parser_version, song IS NOT NULL, file_references
         FROM library_files",
    )?;
    let rows = statement.query_map([], |row| {
        let references: String = row.get(6)?;
        Ok((
            row.get::<_, String>(1)?,
            Stored {
                id: row.get(0)?,
                size: row.get(2)?,
                mtime_ns: row.get(3)?,
                parser_version: row.get(4)?,
                parsed: row.get(5)?,
                references: decode_references(&references),
            },
        ))
    })?;
    rows.collect()
}

/// Stores files just read, replacing their earlier rows (keeping their ids).
pub(crate) fn store_read(
    tx: &Transaction<'_>,
    files: &[ReadFile],
    parser_version: u32,
) -> rusqlite::Result<()> {
    let mut statement = tx.prepare_cached(
        "INSERT INTO library_files (path, size, mtime_ns, parser_version, encoding, song,
             artist, title, duet, txt_problems, file_references)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT (path) DO UPDATE SET
             size = excluded.size, mtime_ns = excluded.mtime_ns,
             parser_version = excluded.parser_version, encoding = excluded.encoding,
             song = excluded.song, artist = excluded.artist, title = excluded.title,
             duet = excluded.duet, txt_problems = excluded.txt_problems,
             file_references = excluded.file_references",
    )?;
    for file in files {
        let song = file
            .song
            .as_ref()
            .map(|s| serde_json::to_string(s).expect("a parsed Song encodes"));
        statement.execute(params![
            file.path,
            file.size,
            file.mtime_ns,
            parser_version,
            file.encoding,
            song,
            file.song.as_ref().map(|s| s.headers.artist.as_str()),
            file.song.as_ref().map(|s| s.headers.title.as_str()),
            file.song.as_ref().is_some_and(|s| s.voices.len() == 2),
            encode_problems(&file.txt_problems),
            encode_references(&file.media.references),
        ])?;
        store_media(tx, &file.path, file.song.is_some(), &file.media)?;
    }
    Ok(())
}

/// Stores what the references of `path` resolved to, and whether it plays.
pub(crate) fn store_media(
    tx: &Transaction<'_>,
    path: &str,
    parsed: bool,
    media: &Media,
) -> rusqlite::Result<()> {
    let playable = parsed
        && !media
            .problems
            .iter()
            .any(|(severity, _)| *severity == ProblemSeverity::Rejection);
    let resolved = |role: Role| {
        media
            .resolved
            .iter()
            .find(|(r, _)| *r == role)
            .map(|(_, path)| path.as_str())
    };
    let identity = if parsed {
        let (artist, title, duet): (String, String, bool) = tx
            .prepare_cached("SELECT artist, title, duet FROM library_files WHERE path = ?1")?
            .query_row([path], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        Some(identity::key(&identity::identity(
            media.usdb_id,
            &artist,
            &title,
            duet,
        )))
    } else {
        None
    };
    let sets: Vec<String> = Role::ALL
        .iter()
        .enumerate()
        .map(|(n, role)| format!("{} = ?{}", role.column(), n + 6))
        .collect();
    let sql = format!(
        "UPDATE library_files SET playable = ?2, file_problems = ?3, usdb_id = ?4, identity = ?5, {}
         WHERE path = ?1",
        sets.join(", ")
    );
    tx.prepare_cached(&sql)?.execute(params![
        path,
        playable,
        encode_problems(&media.problems),
        media.usdb_id.filter(|_| parsed),
        identity,
        resolved(Role::Audio),
        resolved(Role::Video),
        resolved(Role::Cover),
        resolved(Role::Background),
        resolved(Role::Vocals),
        resolved(Role::Instrumental),
    ])?;
    Ok(())
}

/// Removes the rows of files that have gone.
pub(crate) fn remove(tx: &Transaction<'_>, ids: &[i64]) -> rusqlite::Result<()> {
    let mut statement = tx.prepare_cached("DELETE FROM library_files WHERE id = ?1")?;
    for id in ids {
        statement.execute([id])?;
    }
    Ok(())
}

/// Every playable Song, by artist, then title, then path.
pub(crate) fn songs(conn: &Connection) -> rusqlite::Result<Vec<SongSummary>> {
    let mut statement = conn.prepare(
        "SELECT id, path, artist, title, duet, identity FROM library_files WHERE playable
         ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE, path",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(SongSummary {
            id: song_id(row.get(0)?),
            path: row.get(1)?,
            artist: row.get(2)?,
            title: row.get(3)?,
            duet: row.get(4)?,
            identity: decode_identity(row, 5)?,
        })
    })?;
    rows.collect()
}

/// One playable Song in full; `None` for any other id.
pub(crate) fn song(conn: &Connection, id: SongId) -> rusqlite::Result<Option<SongDetail>> {
    conn.query_row(
        "SELECT path, song, txt_problems, file_problems, identity FROM library_files
         WHERE id = ?1 AND playable",
        [id.0],
        |row| {
            let song: String = row.get(1)?;
            let mut problems = decode_problems(&row.get::<_, String>(2)?);
            problems.extend(decode_problems(&row.get::<_, String>(3)?));
            Ok(SongDetail {
                id,
                path: row.get(0)?,
                song: serde_json::from_str(&song).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        e.into(),
                    )
                })?,
                identity: decode_identity(row, 4)?,
                warnings: problems.into_iter().map(|(_, reason)| reason).collect(),
            })
        },
    )
    .optional()
}

/// Whether a playable Song with `identity` is in the Library now. Scoring
/// shows a Song's Score records only while this holds.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Scoring hides and shows Score records by it (#54)"
    )
)]
pub(crate) fn identity_present(
    conn: &Connection,
    identity: &SongIdentity,
) -> rusqlite::Result<bool> {
    conn.prepare_cached(
        "SELECT EXISTS (SELECT 1 FROM library_files WHERE identity = ?1 AND playable)",
    )?
    .query_row([identity::key(identity)], |row| row.get(0))
}

/// Every Library problem, by path: the parser's first, then the references'.
pub(crate) fn problems(conn: &Connection) -> rusqlite::Result<Vec<LibraryProblem>> {
    let mut statement = conn.prepare(
        "SELECT path, txt_problems, file_problems FROM library_files
         WHERE txt_problems != '[]' OR file_problems != '[]'
         ORDER BY path",
    )?;
    let rows = statement.query_map([], |row| {
        let path: String = row.get(0)?;
        let mut problems = decode_problems(&row.get::<_, String>(1)?);
        problems.extend(decode_problems(&row.get::<_, String>(2)?));
        Ok(problems
            .into_iter()
            .map(|(severity, reason)| LibraryProblem {
                path: path.clone(),
                severity,
                reason,
            })
            .collect::<Vec<_>>())
    })?;
    let mut all = Vec::new();
    for row in rows {
        all.extend(row?);
    }
    Ok(all)
}

/// A playable row's identity. Every playable row has one, since the scan
/// sets it whenever it sets `playable`.
fn decode_identity(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<SongIdentity> {
    let text: String = row.get(column)?;
    serde_json::from_str(&text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, e.into())
    })
}

fn song_id(rowid: i64) -> SongId {
    SongId(u32::try_from(rowid).unwrap_or(u32::MAX))
}

fn encode_problems(problems: &[Problem]) -> String {
    serde_json::to_string(problems).expect("problems encode")
}

fn decode_problems(text: &str) -> Vec<Problem> {
    serde_json::from_str(text).unwrap_or_else(|error| {
        tracing::error!(%error, "an indexed problem list does not decode");
        Vec::new()
    })
}

fn encode_references(references: &[Reference]) -> String {
    let list: Vec<(&str, &str, &str)> = references
        .iter()
        .map(|r| (r.role.name(), r.header, r.value.as_str()))
        .collect();
    serde_json::to_string(&list).expect("references encode")
}

fn decode_references(text: &str) -> Vec<Reference> {
    let list: Vec<(String, String, String)> = serde_json::from_str(text).unwrap_or_default();
    list.into_iter()
        .filter_map(|(role, header, value)| {
            Some(Reference {
                role: Role::from_name(&role)?,
                header: header_name(&header)?,
                value,
            })
        })
        .collect()
}

/// The `'static` header key for a stored one.
fn header_name(header: &str) -> Option<&'static str> {
    [
        "MP3",
        "AUDIO",
        "VIDEO",
        "COVER",
        "BACKGROUND",
        "VOCALS",
        "INSTRUMENTAL",
    ]
    .into_iter()
    .find(|h| *h == header)
}
