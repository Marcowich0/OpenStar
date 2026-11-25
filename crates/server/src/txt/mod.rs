//! Reading an UltraStar `.txt`: the lossless line model, the headers and
//! the body.
//!
//! [`parse`] splits a file into lines, classifies them (header, body, `E`,
//! after `E`, blank), interprets the headers and parses the body into
//! Voices, Lines and Notes.

mod body;
mod headers;
mod lines;

pub use lines::{Line, LineEnding, LineKind};
use openstar_protocol::song::{ParsedSong, TxtRejection, TxtWarning};

/// A `.txt` that parsed into a playable Song.
#[derive(Debug, Clone, PartialEq)]
pub struct TxtFile {
    /// Every physical line of the file, in order; concatenating each line's
    /// bytes and ending gives back the file byte for byte.
    pub lines: Vec<Line>,
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
/// The bytes are read as UTF-8 for now (invalid sequences are replaced);
/// encoding detection replaces [`decode`].
pub fn parse(bytes: &[u8], folder_name: &str) -> Result<TxtFile, TxtRejection> {
    let mut lines = Vec::new();
    let mut header_lines = Vec::new();
    let mut body_lines = Vec::new();
    let mut phase = LineKind::Header;

    for (index, (bytes, ending)) in lines::split(bytes).into_iter().enumerate() {
        let number = u32::try_from(index + 1).unwrap_or(u32::MAX);
        let text = decode(&bytes);
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
        song: ParsedSong { headers, voices },
        warnings,
    })
}

/// Turns one line's bytes into text.
fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
