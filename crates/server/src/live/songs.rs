//! The Library lookup the Queue asks before it takes a Request: is this Song
//! in the Library, and can it be queued now? A trait, so tests can stand in
//! for states the real index cannot reach yet ("preparing" comes with #144).

use openstar_protocol::library::SongId;
use rusqlite::{Connection, OptionalExtension};

/// What the Library says about one Song.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SongLookup {
    /// No playable Song has this id.
    NotInLibrary,
    /// In the Library, but its audio is still being prepared: not queueable yet.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the index reports \"preparing\" from #144 on")
    )]
    Preparing { title: String },
    /// In the Library and queueable.
    Ready { title: String },
}

impl SongLookup {
    /// The Song's title, for change events; empty when it left the Library.
    pub fn title(&self) -> &str {
        match self {
            Self::NotInLibrary => "",
            Self::Preparing { title } | Self::Ready { title } => title,
        }
    }
}

/// The lookup seam. Runs on the database's blocking thread.
pub trait Songs: Send + Sync + 'static {
    fn lookup(&self, conn: &Connection, id: SongId) -> rusqlite::Result<SongLookup>;
}

/// The real lookup: the Library index. #144 adds "preparing" here.
pub struct LibraryIndex;

impl Songs for LibraryIndex {
    fn lookup(&self, conn: &Connection, id: SongId) -> rusqlite::Result<SongLookup> {
        let title: Option<Option<String>> = conn
            .query_row(
                "SELECT title FROM library_files WHERE id = ?1 AND playable = 1",
                [id.0],
                |row| row.get(0),
            )
            .optional()?;
        Ok(match title {
            Some(title) => SongLookup::Ready {
                title: title.unwrap_or_default(),
            },
            None => SongLookup::NotInLibrary,
        })
    }
}
