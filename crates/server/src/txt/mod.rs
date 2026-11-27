//! Reading an UltraStar `.txt`: the lossless line model, the headers and
//! the body.
//!
//! [`parse`] splits a file into lines, detects its encoding, classifies the
//! lines (header, body, `E`, after `E`, blank), interprets the headers and
//! parses the body into Voices, Lines and Notes. [`write`] patches a parsed
//! file line by line.

mod body;
mod encoding;
mod headers;
mod lines;
mod writer;

pub use encoding::TxtEncoding;
pub use lines::{Line, LineEnding, LineKind};
use openstar_protocol::song::{ParsedSong, TxtRejection, TxtWarning};
pub use writer::{ChangedLine, NewNote, Operation, WriteError, Written, write};

/// The version of what [`parse`] produces. The Library index stores it with
/// every entry, and a scan re-reads every file indexed by another version, so
/// raise it whenever the parser's output (parsed Song, warnings, rejections or
/// encoding detection) changes for some file.
pub const PARSER_VERSION: u32 = 1;

/// The encoding [`parse`] would decode `bytes` with, for files it rejects.
pub fn detect_encoding(bytes: &[u8]) -> TxtEncoding {
    encoding::detect(bytes, &lines::split(bytes)).0
}

/// A `.txt` that parsed into a playable Song.
#[derive(Debug, Clone, PartialEq)]
pub struct TxtFile {
    /// Every physical line of the file, in order; concatenating each line's
    /// bytes and ending gives back the file byte for byte.
    /// The first line's bytes start with the BOM when [`TxtFile::bom`] is set.
    pub lines: Vec<Line>,
    /// The encoding the file was decoded with; every write reuses it.
    pub encoding: TxtEncoding,
    /// Whether the file starts with a UTF-8 BOM. The BOM is part of no header
    /// or text, only of the first line's bytes.
    pub bom: bool,
    /// The headers, Voices, Lines and Notes.
    pub song: ParsedSong,
    /// Warnings in line order.
    pub warnings: Vec<TxtWarning>,
}

impl TxtFile {
    /// The non-blank lines of the body, from the end of the header up to
    /// (not including) `E`, or to the end of the file when `E` is missing.
    pub fn body(&self) -> impl Iterator<Item = &Line> {
        self.lines.iter().filter(|l| l.kind == LineKind::Body)
    }
}

/// Parses a `.txt` from its bytes. `folder_name` is the name of the folder
/// holding the file; a folder named `Artist - Title` supplies a missing
/// `#ARTIST` or `#TITLE`.
///
/// The encoding is detected once, before parsing (see [`TxtEncoding`]); in
/// UTF-8, invalid sequences are replaced.
pub fn parse(bytes: &[u8], folder_name: &str) -> Result<TxtFile, TxtRejection> {
    let split = lines::split(bytes);
    let (encoding, bom) = encoding::detect(bytes, &split);
    let mut lines = Vec::new();
    let mut header_lines = Vec::new();
    let mut body_lines = Vec::new();
    let mut phase = LineKind::Header;

    for (index, (bytes, ending)) in split.into_iter().enumerate() {
        let number = u32::try_from(index + 1).unwrap_or(u32::MAX);
        let text = if index == 0 && bom {
            encoding.decode(&bytes[encoding::BOM.len()..])
        } else {
            encoding.decode(&bytes)
        };
        let trimmed = text.trim();
        let kind = if phase == LineKind::AfterEnd {
            LineKind::AfterEnd
        } else if trimmed.is_empty() {
            LineKind::Blank
        } else if phase == LineKind::Header && trimmed.starts_with('#') {
            header_lines.push(headers::HeaderLine::new(number, &trimmed[1..]));
            LineKind::Header
        } else if trimmed == "E" {
            phase = LineKind::AfterEnd;
            LineKind::End
        } else {
            phase = LineKind::Body;
            body_lines.push(body::BodyLine { number, text });
            LineKind::Body
        };
        lines.push(Line {
            number,
            bytes,
            ending,
            kind,
        });
    }

    let (headers, mut warnings) = headers::interpret(header_lines, folder_name)?;
    let voices = body::parse(body_lines, &mut warnings)?;
    Ok(TxtFile {
        lines,
        encoding,
        bom,
        song: ParsedSong { headers, voices },
        warnings,
    })
}
