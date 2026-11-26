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
use super::search::Listed;
use openstar_protocol::library::{
    FileProblem, LibraryProblem, MediaFile, ProblemReason, ProblemSeverity, SongDetail, SongId,
    SongIdentity, SongMedia, SongSummary, SongVideo,
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
    /// The chosen cover image, relative to the Library.
    pub cover: Option<String>,
    /// The chosen background image (`#BACKGROUND`, else the cover).
    pub background: Option<String>,
}

/// A `.txt` just read, ready to be stored.
pub(crate) struct ReadFile {
    pub path: String,
    pub size: i64,
    pub mtime_ns: i64,
    /// The SHA-256 of the bytes read (lower-case hex); `None` when the file
    /// could not be read.
    pub sha256: Option<String>,
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

/// A parsed `.txt` as the index last read it: what a Timing edit checks
/// the file on disk against.
pub(crate) struct Loaded {
    /// Relative to the Library, `/` between segments.
    pub path: String,
    pub mtime_ns: i64,
    /// `None` for a row read before the index kept hashes (it is read again
    /// at the next scan).
    pub sha256: Option<String>,
}

/// The row of Song `id` if its `.txt` parsed (playable or not).
pub(crate) fn loaded(conn: &Connection, id: SongId) -> rusqlite::Result<Option<Loaded>> {
    conn.query_row(
        "SELECT path, mtime_ns, txt_sha256 FROM library_files
         WHERE id = ?1 AND song IS NOT NULL",
        [id.0],
        |row| {
            Ok(Loaded {
                path: row.get(0)?,
                mtime_ns: row.get(1)?,
                sha256: row.get(2)?,
            })
        },
    )
    .optional()
}

/// Every parsed row: its Song and `.txt` path.
pub(crate) fn parsed_paths(conn: &Connection) -> rusqlite::Result<Vec<(SongId, String)>> {
    let mut statement =
        conn.prepare("SELECT id, path FROM library_files WHERE song IS NOT NULL ORDER BY id")?;
    statement
        .query_map([], |row| Ok((song_id(row.get(0)?), row.get(1)?)))?
        .collect()
}

/// Stores files just read, replacing their earlier rows (keeping their ids).
pub(crate) fn store_read(
    tx: &Transaction<'_>,
    files: &[ReadFile],
    parser_version: u32,
) -> rusqlite::Result<()> {
    let mut statement = tx.prepare_cached(
        "INSERT INTO library_files (path, size, mtime_ns, parser_version, encoding, song,
             artist, title, duet, txt_problems, file_references,
             year, languages, genres, editions, creators, txt_sha256)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT (path) DO UPDATE SET
             size = excluded.size, mtime_ns = excluded.mtime_ns,
             parser_version = excluded.parser_version, encoding = excluded.encoding,
             song = excluded.song, artist = excluded.artist, title = excluded.title,
             duet = excluded.duet, txt_problems = excluded.txt_problems,
             file_references = excluded.file_references, year = excluded.year,
             languages = excluded.languages, genres = excluded.genres,
             editions = excluded.editions, creators = excluded.creators,
             txt_sha256 = excluded.txt_sha256",
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
            file.song.as_ref().and_then(|s| s.headers.year),
            encode_values(file.song.as_ref().map(|s| &s.headers.languages)),
            encode_values(file.song.as_ref().map(|s| &s.headers.genres)),
            encode_values(file.song.as_ref().map(|s| &s.headers.editions)),
            encode_values(file.song.as_ref().map(|s| &s.headers.creators)),
            file.sha256,
        ])?;
        store_media(tx, &file.path, file.song.is_some(), &file.media)?;
    }
    Ok(())
}

/// Stores a file OpenStar itself just wrote, like [`store_read`], and when
/// that changed the row's identity key (artist, title or duet of a Song
/// without a USDB id) moves the Score records of the old key to the new one
/// in the same transaction. Records stay with the old key while another
/// copy in the Library still has it. A file changed by another program is
/// read by a scan through [`store_read`] and never moves records.
pub(crate) fn store_own_write(
    tx: &Transaction<'_>,
    file: &ReadFile,
    parser_version: u32,
) -> rusqlite::Result<()> {
    let identity_of = |tx: &Transaction<'_>| -> rusqlite::Result<Option<String>> {
        Ok(tx
            .query_row(
                "SELECT identity FROM library_files WHERE path = ?1",
                [&file.path],
                |row| row.get(0),
            )
            .optional()?
            .flatten())
    };
    let before = identity_of(tx)?;
    store_read(tx, std::slice::from_ref(file), parser_version)?;
    let after = identity_of(tx)?;
    let (Some(before), Some(after)) = (before, after) else {
        return Ok(());
    };
    let still_held: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM library_files WHERE identity = ?1)",
        [&before],
        |row| row.get(0),
    )?;
    if before == after || still_held {
        return Ok(());
    }
    let decode = |key: &str| {
        serde_json::from_str::<SongIdentity>(key).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
        })
    };
    let moved = crate::scores::move_identity_in(tx, &decode(&before)?, &decode(&after)?)?;
    tracing::info!(path = %file.path, moved, "an own edit changed a Song's identity key");
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
        media.cover.as_deref(),
        media.background.as_deref(),
        resolved(Role::Vocals),
        resolved(Role::Instrumental),
    ])?;
    refresh(tx, &Refresh::Row(path))
}

/// Which rows [`refresh`] updates.
pub(crate) enum Refresh<'a> {
    All,
    /// The row of this `.txt`.
    Row(&'a str),
    /// The rows that play or show this media file.
    Media(&'a str),
}

/// Updates what follows a row's media conversions (see
/// `library::conversion`): `preparing` while its audio converts,
/// `conversion_problems` (audio that could not be converted is a
/// rejection, video a warning), `playable` (no rejection), and `has_video`
/// (a `#VIDEO` file that, once probed readable, holds video, and whose
/// conversion did not fail).
pub(crate) fn refresh(conn: &Connection, rows: &Refresh<'_>) -> rusqlite::Result<()> {
    let (filter, param) = match rows {
        Refresh::All => ("1", None),
        Refresh::Row(path) => ("path = ?1", Some(*path)),
        Refresh::Media(path) => ("(audio_path = ?1 OR video_path = ?1)", Some(*path)),
    };
    let sql = format!(
        "SELECT id, song IS NOT NULL, file_problems, audio_path, video_path,
             (SELECT state FROM media_conversions c WHERE c.path = audio_path),
             (SELECT state FROM media_conversions c WHERE c.path = video_path),
             (SELECT container IS NULL OR video_codec IS NOT NULL
              FROM media_probes p WHERE p.path = video_path)
         FROM library_files WHERE {filter}"
    );
    let mut select = conn.prepare_cached(&sql)?;
    let mut update = conn.prepare_cached(
        "UPDATE library_files SET preparing = ?2, conversion_problems = ?3, playable = ?4,
             has_video = ?5
         WHERE id = ?1",
    )?;
    let read = |row: &rusqlite::Row<'_>| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, bool>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<bool>>(7)?,
        ))
    };
    let rows: Vec<_> = match param {
        Some(path) => select.query_map([path], read)?.collect::<Result<_, _>>()?,
        None => select.query_map([], read)?.collect::<Result<_, _>>()?,
    };
    for (id, parsed, file_problems, audio, video, audio_state, video_state, video_stream) in rows {
        let mut problems: Vec<Problem> = Vec::new();
        let audio_failed = audio_state.as_deref() == Some("failed");
        let separate_video = video.is_some() && video != audio;
        let video_failed = separate_video && video_state.as_deref() == Some("failed");
        if let (true, Some(file)) = (audio_failed, &audio) {
            problems.push((
                ProblemSeverity::Rejection,
                ProblemReason::File(FileProblem::AudioNotConverted { file: file.clone() }),
            ));
        }
        if let (true, Some(file)) = (video_failed, &video) {
            problems.push((
                ProblemSeverity::Warning,
                ProblemReason::File(FileProblem::VideoNotConverted { file: file.clone() }),
            ));
        }
        let playable = parsed
            && !audio_failed
            && !decode_problems(&file_problems)
                .iter()
                .any(|(severity, _)| *severity == ProblemSeverity::Rejection);
        let preparing = parsed && audio_state.as_deref() == Some("converting");
        let has_video = video.is_some() && video_stream.unwrap_or(true) && !video_failed;
        update.execute(params![
            id,
            preparing,
            encode_problems(&problems),
            playable,
            has_video
        ])?;
    }
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

/// The listed Songs: every playable Song, each identity once, by artist,
/// then title, then path, with the fields the filters look at.
///
/// Of the copies of one identity, the one whose `.txt` is newest is listed
/// (then the lowest id). #142 owns the full preferred-copy rule (an edited
/// copy first, then one whose media plays natively) and replaces the
/// `ORDER BY` of the window here.
pub(crate) fn listed(conn: &Connection) -> rusqlite::Result<Vec<Listed>> {
    let mut statement = conn.prepare(
        "SELECT id, path, artist, title, duet, identity, length_seconds, has_video,
             cover_path IS NOT NULL, year, languages, genres, editions, creators, preparing
         FROM (
             SELECT *, ROW_NUMBER() OVER (
                 PARTITION BY identity ORDER BY mtime_ns DESC, id
             ) AS copy
             FROM library_files WHERE playable
         )
         WHERE copy = 1
         ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE, path",
    )?;
    let rows = statement.query_map([], |row| {
        let id = song_id(row.get(0)?);
        let identity = decode_identity(row, 5)?;
        Ok(Listed {
            summary: SongSummary {
                id,
                path: row.get(1)?,
                artist: row.get(2)?,
                title: row.get(3)?,
                duet: row.get(4)?,
                length_seconds: row.get(6)?,
                has_video: row.get(7)?,
                preparing: row.get(14)?,
                cover: image_url(id, MediaRole::Cover, row.get(8)?),
                tile_colour: super::artwork::tile_colour(&identity),
                identity,
                top_high_score: None,
                year: row.get(9)?,
            },
            year: row.get(9)?,
            languages: decode_values(row.get(10)?),
            genres: decode_values(row.get(11)?),
            editions: decode_values(row.get(12)?),
            creators: decode_values(row.get(13)?),
        })
    })?;
    rows.collect()
}

/// One playable Song in full; `None` for any other id.
pub(crate) fn song(conn: &Connection, id: SongId) -> rusqlite::Result<Option<SongDetail>> {
    conn.query_row(
        "SELECT path, song, txt_problems, file_problems, identity, length_seconds,
             audio_path, video_path, cover_path IS NOT NULL, background_path IS NOT NULL,
             has_video,
             (SELECT native FROM media_probes p WHERE p.path = audio_path),
             (SELECT native FROM media_probes p WHERE p.path = video_path),
             preparing, conversion_problems,
             (SELECT state FROM media_conversions c WHERE c.path = audio_path),
             (SELECT state FROM media_conversions c WHERE c.path = video_path),
             (SELECT l.lufs FROM media_loudness l JOIN media_probes p
              ON p.path = l.path AND p.size = l.size AND p.mtime_ns = l.mtime_ns
              WHERE l.path = audio_path)
         FROM library_files
         WHERE id = ?1 AND playable",
        [id.0],
        |row| {
            let song: ParsedSong =
                serde_json::from_str(&row.get::<_, String>(1)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        e.into(),
                    )
                })?;
            let mut problems = decode_problems(&row.get::<_, String>(2)?);
            problems.extend(decode_problems(&row.get::<_, String>(3)?));
            problems.extend(decode_problems(&row.get::<_, String>(14)?));
            let identity = decode_identity(row, 4)?;
            let audio_path: String = row.get(6)?;
            let video_path: Option<String> = row.get(7)?;
            let has_video: bool = row.get(10)?;
            // A converted copy is served in the file's place, and plays.
            let converted = |state: Option<String>| state.as_deref() == Some("done");
            let audio_state: Option<String> = row.get(15)?;
            let video_state: Option<String> = row.get(16)?;
            let audio_native =
                row.get::<_, Option<bool>>(11)?.unwrap_or(false) || converted(audio_state);
            let video_ready = video_state.as_deref().is_none_or(|s| s == "done");
            let video_native =
                row.get::<_, Option<bool>>(12)?.unwrap_or(false) || converted(video_state);
            let video = match video_path {
                Some(_) if !has_video => None,
                Some(video) if video == audio_path => Some(SongVideo::InAudio),
                // Still converting: the Song plays over its background or cover.
                Some(_) if !video_ready => None,
                Some(_) => Some(SongVideo::File {
                    file: MediaFile {
                        url: media_url(id, MediaRole::Video),
                        native: video_native,
                    },
                    gap_seconds: song.headers.video_gap_seconds.unwrap_or(0.0),
                }),
                None => None,
            };
            let media = SongMedia {
                audio: MediaFile {
                    url: media_url(id, MediaRole::Audio),
                    native: audio_native,
                },
                video,
                cover: image_url(id, MediaRole::Cover, row.get(8)?),
                background: image_url(id, MediaRole::Background, row.get(9)?),
                tile_colour: super::artwork::tile_colour(&identity),
            };
            Ok(SongDetail {
                id,
                path: row.get(0)?,
                note_fingerprint: crate::scores::note_fingerprint(&song),
                song,
                identity,
                length_seconds: row.get(5)?,
                preparing: row.get(13)?,
                media,
                loudness_lufs: row.get(17)?,
                warnings: problems.into_iter().map(|(_, reason)| reason).collect(),
                loaded_at_ms: None,
            })
        },
    )
    .optional()
}

/// A file of a Song that `GET /api/songs/{id}/media/{role}` serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MediaRole {
    Audio,
    Video,
    Cover,
    Background,
}

impl MediaRole {
    pub(crate) fn from_name(name: &str) -> Option<Self> {
        match name {
            "audio" => Some(Self::Audio),
            "video" => Some(Self::Video),
            "cover" => Some(Self::Cover),
            "background" => Some(Self::Background),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Audio => "audio",
            Self::Video => "video",
            Self::Cover => "cover",
            Self::Background => "background",
        }
    }

    fn column(self) -> &'static str {
        match self {
            Self::Audio => "audio_path",
            Self::Video => "video_path",
            Self::Cover => "cover_path",
            Self::Background => "background_path",
        }
    }
}

/// The URL a Song's file is served at.
fn media_url(id: SongId, role: MediaRole) -> String {
    format!("/api/songs/{}/media/{}", id.0, role.name())
}

/// The URL of the image at `role`, when the Song has one.
fn image_url(id: SongId, role: MediaRole, has_image: bool) -> Option<String> {
    has_image.then(|| media_url(id, role))
}

/// The Library file a playable Song plays or shows as `role`, relative to
/// the Library; `None` when it has none.
pub(crate) fn media_path(
    conn: &Connection,
    id: SongId,
    role: MediaRole,
) -> rusqlite::Result<Option<String>> {
    let sql = format!(
        "SELECT {} FROM library_files WHERE id = ?1 AND playable",
        role.column()
    );
    Ok(conn
        .query_row(&sql, [id.0], |row| row.get::<_, Option<String>>(0))
        .optional()?
        .flatten())
}

/// The playable Song with `identity` in the Library now, the newest when
/// there are several. A finished Download names its new Song by it.
pub(crate) fn song_with_identity(
    conn: &Connection,
    identity: &SongIdentity,
) -> rusqlite::Result<Option<SongId>> {
    conn.prepare_cached(
        "SELECT id FROM library_files WHERE identity = ?1 AND playable ORDER BY id DESC LIMIT 1",
    )?
    .query_row([identity::key(identity)], |row| row.get(0).map(SongId))
    .optional()
}

/// Whether a playable Song with `identity` is in the Library now. Scoring
/// shows a Song's Score records only while this holds; USDB search marks a
/// song "In Library" by it.
pub(crate) fn identity_present(
    conn: &Connection,
    identity: &SongIdentity,
) -> rusqlite::Result<bool> {
    conn.prepare_cached(
        "SELECT EXISTS (SELECT 1 FROM library_files WHERE identity = ?1 AND playable)",
    )?
    .query_row([identity::key(identity)], |row| row.get(0))
}

/// Every Library problem, by path: the parser's first, then the
/// references', then the conversions'.
pub(crate) fn problems(conn: &Connection) -> rusqlite::Result<Vec<LibraryProblem>> {
    let mut statement = conn.prepare(
        "SELECT path, txt_problems, file_problems, conversion_problems FROM library_files
         WHERE txt_problems != '[]' OR file_problems != '[]' OR conversion_problems != '[]'
         ORDER BY path",
    )?;
    let rows = statement.query_map([], |row| {
        let path: String = row.get(0)?;
        let mut problems = decode_problems(&row.get::<_, String>(1)?);
        problems.extend(decode_problems(&row.get::<_, String>(2)?));
        problems.extend(decode_problems(&row.get::<_, String>(3)?));
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

/// A list header's values as a row stores them (JSON); `None` for a
/// rejected `.txt`.
fn encode_values(values: Option<&Vec<String>>) -> Option<String> {
    values.map(|v| serde_json::to_string(v).expect("values encode"))
}

fn decode_values(text: Option<String>) -> Vec<String> {
    text.map(|t| {
        serde_json::from_str(&t).unwrap_or_else(|error| {
            tracing::error!(%error, "an indexed value list does not decode");
            Vec::new()
        })
    })
    .unwrap_or_default()
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
