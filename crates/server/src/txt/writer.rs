//! Writing a `.txt` back: a line-level patcher over the parser's line model,
//! ported from the Timing editor prototype's write-back (`timing.js`).
//!
//! [`write`] applies [`Operation`]s to a parsed [`TxtFile`] and returns the
//! new bytes plus the lines that changed. Unchanged lines stay
//! byte-identical (a BOM included). A changed line keeps its own line ending
//! and its own separators: only the bytes of the field that changed are
//! replaced, so a lyric's bytes survive a change of the Note's start. New
//! lines take the line ending of the line before them.
//!
//! When new text cannot be encoded in the file's encoding, the whole file is
//! rewritten as UTF-8 with `#ENCODING:UTF8`.

use std::collections::{BTreeMap, HashMap, HashSet};

use openstar_protocol::song::NoteKind;

use super::encoding::BOM;
use super::{LineEnding, LineKind, TxtEncoding, TxtFile, headers};

/// One change to a `.txt`. Notes and Line end markers are named by the
/// 1-based line number they have in the parsed file (`Note::line`,
/// `LineEnd::line`); line numbers always refer to the file as parsed, never
/// to a file with earlier operations applied.
#[derive(Debug, Clone, PartialEq)]
pub enum Operation {
    SetNoteStart {
        line: u32,
        start: i32,
    },
    SetNoteLength {
        line: u32,
        length: i32,
    },
    SetNotePitch {
        line: u32,
        pitch: i32,
    },
    /// The lyric, with its leading and trailing spaces as they should be.
    SetNoteText {
        line: u32,
        text: String,
    },
    /// A new Note line placed after line `after`. Several inserts after one
    /// line keep the order of the operations.
    InsertNote {
        after: u32,
        note: NewNote,
    },
    DeleteNote {
        line: u32,
    },
    /// `#GAP`, given in seconds and written in milliseconds.
    SetGap {
        seconds: f64,
    },
    /// `#BPM`, given as the real beat rate (as in
    /// `SongHeaders::beats_per_minute`) and written as that rate ÷ 4.
    SetBpm {
        beats_per_minute: f64,
    },
    /// `#VIDEOGAP`, in seconds.
    SetVideoGap {
        seconds: f64,
    },
    /// The beat of a Line end marker.
    SetLineEnd {
        line: u32,
        beat: i32,
    },
}

/// A Note to insert.
#[derive(Debug, Clone, PartialEq)]
pub struct NewNote {
    pub kind: NoteKind,
    pub start: i32,
    pub length: i32,
    pub pitch: i32,
    pub text: String,
}

/// An operation the writer refuses; nothing is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteError {
    /// The file has no line with this number.
    NoSuchLine { line: u32 },
    /// The line is not a Note line.
    NotANote { line: u32 },
    /// The line is not a Line end marker that closes a Line.
    NotALineEnd { line: u32 },
    /// An earlier operation deleted this Note.
    NoteDeleted { line: u32 },
    /// A lyric holds a line break; `line` is the Note's line, or the line
    /// the new Note is inserted after.
    LineBreakInText { line: u32 },
    /// A header value that is not finite, or a `#BPM` the parser would
    /// reject (a real rate below 1).
    InvalidNumber,
}

/// The result of [`write`].
#[derive(Debug, Clone, PartialEq)]
pub struct Written {
    /// The new file.
    pub bytes: Vec<u8>,
    /// The encoding of [`Written::bytes`]: the file's own, or UTF-8 after
    /// the encoding fallback, when every line is re-encoded.
    pub encoding: TxtEncoding,
    /// The lines whose text changed, in file order. Lines that are only
    /// re-encoded by the fallback are not listed.
    pub changed: Vec<ChangedLine>,
}

/// One changed line, for the Timing edit preview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedLine {
    /// The 1-based line number in the new file; for a deleted line, the
    /// number it had in the old file.
    pub line: u32,
    /// The old text, without its line ending; `None` for an inserted line.
    pub old: Option<String>,
    /// The new text, without its line ending; `None` for a deleted line.
    pub new: Option<String>,
}

/// Applies `operations` in order to `file`. With no operations, or with
/// operations that change nothing, the result is the input byte for byte.
pub fn write(file: &TxtFile, operations: &[Operation]) -> Result<Written, WriteError> {
    let mut draft = Draft::new(file);
    for operation in operations {
        draft.apply(operation)?;
    }
    Ok(draft.finish())
}

/// Part of a line being written: bytes already in the file's encoding, or
/// new text that still has to be encoded.
#[derive(Debug, Clone, PartialEq)]
enum Piece {
    Raw(Vec<u8>),
    Text(String),
}

const SEPARATORS: &[u8] = b" \t";

/// An integer field of a body line: its bytes as written and its value.
#[derive(Debug, Clone)]
struct Field {
    bytes: Vec<u8>,
    value: i32,
}

impl Field {
    /// Reads a run of non-separator bytes starting at `at`. Returns the
    /// field and the index after it.
    fn read(bytes: &[u8], at: usize) -> Option<(Field, usize)> {
        let end = bytes[at..]
            .iter()
            .position(|b| SEPARATORS.contains(b))
            .map_or(bytes.len(), |p| at + p);
        let value = std::str::from_utf8(&bytes[at..end]).ok()?.parse().ok()?;
        Some((
            Field {
                bytes: bytes[at..end].to_vec(),
                value,
            },
            end,
        ))
    }

    /// Sets the value; the bytes change only when the value does, so `007`
    /// set to 7 stays `007`.
    fn set(&mut self, value: i32) {
        if value != self.value {
            self.value = value;
            self.bytes = value.to_string().into_bytes();
        }
    }
}

fn separator_run(bytes: &[u8], at: usize) -> usize {
    at + bytes[at..]
        .iter()
        .take_while(|b| SEPARATORS.contains(b))
        .count()
}

/// A Note line split into its parts, every separator kept as written:
/// `head` is any indentation plus the type character.
#[derive(Debug, Clone)]
struct NoteLine {
    head: Vec<u8>,
    fields: [(Vec<u8>, Field); 3],
    /// The single separator before the lyric and the lyric itself; `None`
    /// when the line ends after the pitch.
    text: Option<(Vec<u8>, Piece)>,
}

impl NoteLine {
    /// Splits a line the parser read as a Note (see `body::note`).
    fn read(bytes: &[u8]) -> Option<NoteLine> {
        let type_at = separator_run(bytes, 0);
        let mut at = type_at + 1;
        let head = bytes.get(..at)?.to_vec();
        let mut field = || {
            let start = separator_run(bytes, at);
            let (field, end) = Field::read(bytes, start)?;
            let separator = bytes[at..start].to_vec();
            at = end;
            Some((separator, field))
        };
        let fields = [field()?, field()?, field()?];
        let text = (at < bytes.len()).then(|| {
            (
                bytes[at..=at].to_vec(),
                Piece::Raw(bytes[at + 1..].to_vec()),
            )
        });
        Some(NoteLine { head, fields, text })
    }

    fn pieces(&self) -> Vec<Piece> {
        let mut raw = self.head.clone();
        for (separator, field) in &self.fields {
            raw.extend_from_slice(separator);
            raw.extend_from_slice(&field.bytes);
        }
        let mut pieces = Vec::new();
        match &self.text {
            None => pieces.push(Piece::Raw(raw)),
            Some((separator, text)) => {
                raw.extend_from_slice(separator);
                pieces.push(Piece::Raw(raw));
                pieces.push(text.clone());
            }
        }
        pieces
    }
}

/// A Line end marker split into its parts: `head` is any indentation, `-`
/// and the separators before the beat; `rest` is everything after the beat.
#[derive(Debug, Clone)]
struct LineEndLine {
    head: Vec<u8>,
    beat: Field,
    rest: Vec<u8>,
}

impl LineEndLine {
    fn read(bytes: &[u8]) -> Option<LineEndLine> {
        let dash = separator_run(bytes, 0);
        let start = separator_run(bytes, dash + 1);
        let (beat, end) = Field::read(bytes, start)?;
        Some(LineEndLine {
            head: bytes[..start].to_vec(),
            beat,
            rest: bytes[end..].to_vec(),
        })
    }

    fn pieces(&self) -> Vec<Piece> {
        vec![Piece::Raw(
            [self.head.as_slice(), &self.beat.bytes, &self.rest].concat(),
        )]
    }
}

/// A numeric header the writer sets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum NumericHeader {
    Bpm,
    Gap,
    VideoGap,
}

impl NumericHeader {
    fn key(self) -> &'static str {
        match self {
            NumericHeader::Bpm => "BPM",
            NumericHeader::Gap => "GAP",
            NumericHeader::VideoGap => "VIDEOGAP",
        }
    }
}

/// The edits collected so far, keyed by the parsed file's line numbers.
struct Draft<'a> {
    file: &'a TxtFile,
    notes: HashMap<u32, Option<NoteLine>>,
    ends: HashMap<u32, LineEndLine>,
    note_lines: HashSet<u32>,
    end_lines: HashSet<u32>,
    /// Header values in the file's own units, in the order first set.
    headers: Vec<(NumericHeader, f64)>,
    /// New lines after a line number (0 = before the first line).
    inserted: BTreeMap<u32, Vec<Vec<Piece>>>,
    /// Whole-line replacements (headers).
    replaced: HashMap<u32, Vec<Piece>>,
}

impl<'a> Draft<'a> {
    fn new(file: &'a TxtFile) -> Self {
        let lines = file.song.voices.iter().flat_map(|v| &v.lines);
        let note_lines = lines
            .clone()
            .flat_map(|l| &l.notes)
            .map(|n| n.line)
            .collect();
        let end_lines = lines
            .filter_map(|l| l.end.as_ref())
            .map(|e| e.line)
            .collect();
        Draft {
            file,
            notes: HashMap::new(),
            ends: HashMap::new(),
            note_lines,
            end_lines,
            headers: Vec::new(),
            inserted: BTreeMap::new(),
            replaced: HashMap::new(),
        }
    }

    fn line_bytes(&self, line: u32) -> Option<&'a [u8]> {
        let index = usize::try_from(line).ok()?.checked_sub(1)?;
        self.file.lines.get(index).map(|l| l.bytes.as_slice())
    }

    /// The Note on `line`, read once and then edited in place.
    fn note(&mut self, line: u32) -> Result<&mut NoteLine, WriteError> {
        if !self.note_lines.contains(&line) {
            return Err(match self.line_bytes(line) {
                None => WriteError::NoSuchLine { line },
                Some(_) => WriteError::NotANote { line },
            });
        }
        let bytes = self.line_bytes(line).unwrap_or_default();
        self.notes
            .entry(line)
            .or_insert_with(|| NoteLine::read(bytes))
            .as_mut()
            .ok_or(WriteError::NoteDeleted { line })
    }

    fn apply(&mut self, operation: &Operation) -> Result<(), WriteError> {
        match operation {
            Operation::SetNoteStart { line, start } => self.note(*line)?.fields[0].1.set(*start),
            Operation::SetNoteLength { line, length } => {
                self.note(*line)?.fields[1].1.set(*length);
            }
            Operation::SetNotePitch { line, pitch } => self.note(*line)?.fields[2].1.set(*pitch),
            Operation::SetNoteText { line, text } => {
                check_text(text, *line)?;
                let encoding = self.file.encoding;
                let note = self.note(*line)?;
                let unchanged = match &note.text {
                    Some((_, Piece::Raw(bytes))) => encoding.decode(bytes) == *text,
                    Some((_, Piece::Text(old))) => old == text,
                    None => text.is_empty(),
                };
                if !unchanged {
                    let separator = note.text.take().map_or(b" ".to_vec(), |(s, _)| s);
                    note.text = Some((separator, Piece::Text(text.clone())));
                }
            }
            Operation::DeleteNote { line } => {
                self.note(*line)?;
                self.notes.insert(*line, None);
            }
            Operation::InsertNote { after, note } => {
                check_text(&note.text, *after)?;
                let bytes = self
                    .line_bytes(*after)
                    .ok_or(WriteError::NoSuchLine { line: *after })?;
                let pieces = self.new_note(bytes, *after, note);
                self.inserted.entry(*after).or_default().push(pieces);
            }
            Operation::SetLineEnd { line, beat } => {
                if !self.end_lines.contains(line) {
                    return Err(match self.line_bytes(*line) {
                        None => WriteError::NoSuchLine { line: *line },
                        Some(_) => WriteError::NotALineEnd { line: *line },
                    });
                }
                let bytes = self.line_bytes(*line).unwrap_or_default();
                self.ends
                    .entry(*line)
                    .or_insert_with(|| {
                        LineEndLine::read(bytes).expect("the parser read this line as a Line end")
                    })
                    .beat
                    .set(*beat);
            }
            Operation::SetGap { seconds } => {
                self.set_header(NumericHeader::Gap, seconds * 1000.0)?
            }
            Operation::SetBpm { beats_per_minute } => {
                self.set_header(NumericHeader::Bpm, beats_per_minute / 4.0)?;
            }
            Operation::SetVideoGap { seconds } => {
                self.set_header(NumericHeader::VideoGap, *seconds)?;
            }
        }
        Ok(())
    }

    /// A new Note line, with the separators of the line it follows when
    /// that is a Note line, single spaces otherwise.
    fn new_note(&self, after_bytes: &[u8], after: u32, note: &NewNote) -> Vec<Piece> {
        let template = self
            .note_lines
            .contains(&after)
            .then(|| NoteLine::read(after_bytes))
            .flatten();
        let separator = |i: usize| match &template {
            Some(t) if !t.fields[i].0.is_empty() => t.fields[i].0.clone(),
            _ => b" ".to_vec(),
        };
        let field = |value: i32| Field {
            bytes: value.to_string().into_bytes(),
            value,
        };
        let line = NoteLine {
            head: vec![note_character(note.kind)],
            fields: [
                (separator(0), field(note.start)),
                (separator(1), field(note.length)),
                (separator(2), field(note.pitch)),
            ],
            text: Some((
                template
                    .and_then(|t| t.text.map(|(s, _)| s))
                    .unwrap_or(b" ".to_vec()),
                Piece::Text(note.text.clone()),
            )),
        };
        line.pieces()
    }

    fn set_header(&mut self, header: NumericHeader, value: f64) -> Result<(), WriteError> {
        let value = round2(value);
        if !value.is_finite() || (header == NumericHeader::Bpm && value * 4.0 < 1.0) {
            return Err(WriteError::InvalidNumber);
        }
        match self.headers.iter_mut().find(|(h, _)| *h == header) {
            Some(entry) => entry.1 = value,
            None => self.headers.push((header, value)),
        }
        Ok(())
    }

    /// The header line the parser takes `key` from: the last one with a
    /// non-empty value, else the last one with a colon.
    fn header_line(&self, key: &str) -> Option<u32> {
        let mut found = None;
        let mut found_empty = None;
        for line in self
            .file
            .lines
            .iter()
            .filter(|l| l.kind == LineKind::Header)
        {
            let text = self.decode(line.number, &line.bytes);
            let Some((k, value)) = text.trim().trim_start_matches('#').split_once(':') else {
                continue;
            };
            if k.trim().eq_ignore_ascii_case(key) {
                if value.trim().is_empty() {
                    found_empty = Some(line.number);
                } else {
                    found = Some(line.number);
                }
            }
        }
        found.or(found_empty)
    }

    /// Decodes a line of the parsed file, without the BOM.
    fn decode(&self, line: u32, bytes: &[u8]) -> String {
        let bytes = if line == 1 && self.file.bom {
            &bytes[BOM.len()..]
        } else {
            bytes
        };
        self.file.encoding.decode(bytes)
    }

    /// Replaces the value of header line `line` with `value`, keeping
    /// everything before it (`#`, the key as written, the colon and any
    /// spaces) and any trailing spaces. `None` when the value is unchanged.
    fn header_value(&self, line: u32, value: &str) -> Option<Vec<Piece>> {
        let bytes = self.line_bytes(line)?;
        let colon = bytes.iter().position(|b| *b == b':')?;
        let start = separator_run(bytes, colon + 1);
        let end = start + bytes[start..].trim_ascii_end().len();
        let new = [&bytes[..start], value.as_bytes(), &bytes[end..]].concat();
        (new != bytes).then(|| vec![Piece::Raw(new)])
    }

    fn finish(mut self) -> Written {
        for (header, value) in self.headers.clone() {
            self.write_header(header, value);
        }
        let mut out = self.assemble(self.file.encoding);
        let mut encoding = self.file.encoding;
        if out.is_none() {
            encoding = TxtEncoding::Utf8;
            self.mark_utf8();
            out = self.assemble(encoding);
        }
        let (lines, changed) = out.expect("every text encodes in UTF-8");
        Written {
            bytes: lines.concat(),
            encoding,
            changed,
        }
    }

    fn write_header(&mut self, header: NumericHeader, value: f64) {
        let key = header.key();
        match self.header_line(key) {
            Some(line) => {
                let bytes = self.line_bytes(line).unwrap_or_default();
                let colon = bytes.iter().position(|b| *b == b':').unwrap_or(0);
                let old = String::from_utf8_lossy(&bytes[colon + 1..]);
                let old = old.trim();
                if headers::parse_decimal(old) == Some(value) {
                    return;
                }
                let text = format_number(value, old.contains(','));
                if let Some(pieces) = self.header_value(line, &text) {
                    self.replaced.insert(line, pieces);
                }
            }
            None => {
                if header != NumericHeader::Bpm && value == 0.0 {
                    return;
                }
                let bpm = self.header_line("BPM").unwrap_or(0);
                let text = format!("#{key}:{}", format_number(value, false));
                self.inserted
                    .entry(bpm)
                    .or_default()
                    .push(vec![Piece::Raw(text.into_bytes())]);
            }
        }
    }

    /// The fallback: `#ENCODING:UTF8` replaces the `#ENCODING` line, or
    /// becomes the first line.
    fn mark_utf8(&mut self) {
        match self.header_line("ENCODING") {
            Some(line) => {
                let pieces = self
                    .header_value(line, "UTF8")
                    .unwrap_or_else(|| vec![Piece::Raw(self.line_bytes(line).unwrap().to_vec())]);
                self.replaced.insert(line, pieces);
            }
            None => self
                .inserted
                .entry(0)
                .or_default()
                .insert(0, vec![Piece::Raw(b"#ENCODING:UTF8".to_vec())]),
        }
    }

    /// The new file's lines (with their endings) in `encoding`, and the
    /// changed lines. `None` when some new text cannot be encoded.
    fn assemble(&self, encoding: TxtEncoding) -> Option<(Vec<Vec<u8>>, Vec<ChangedLine>)> {
        let source = self.file.encoding;
        let reencode = encoding != source;
        let render = |pieces: &[Piece]| -> Option<Vec<u8>> {
            let mut out = Vec::new();
            for piece in pieces {
                match piece {
                    Piece::Raw(bytes) if !reencode => out.extend_from_slice(bytes),
                    Piece::Raw(bytes) => out.extend(encode(encoding, &source.decode(bytes))?),
                    Piece::Text(text) => out.extend(encode(encoding, text)?),
                }
            }
            Some(out)
        };

        // (bytes, ending or None for "take the previous line's", change)
        let mut out: Vec<(Vec<u8>, Option<LineEnding>, Option<ChangedLine>)> = Vec::new();
        let push_inserted = |out: &mut Vec<_>, after: u32| -> Option<()> {
            for pieces in self.inserted.get(&after).into_iter().flatten() {
                let bytes = render(pieces)?;
                let change = ChangedLine {
                    line: 0,
                    old: None,
                    new: Some(encoding.decode(&bytes)),
                };
                out.push((bytes, None, Some(change)));
            }
            Some(())
        };
        push_inserted(&mut out, 0)?;
        let mut deleted = Vec::new();
        for line in &self.file.lines {
            let number = line.number;
            let old_text = || self.decode(number, &line.bytes);
            let pieces = match (self.notes.get(&number), self.ends.get(&number)) {
                (Some(None), _) => {
                    deleted.push((
                        out.len(),
                        ChangedLine {
                            line: number,
                            old: Some(old_text()),
                            new: None,
                        },
                    ));
                    push_inserted(&mut out, number)?;
                    continue;
                }
                (Some(Some(note)), _) => Some(note.pieces()),
                (None, Some(end)) => Some(end.pieces()),
                (None, None) => self.replaced.get(&number).cloned(),
            };
            let bom = number == 1 && self.file.bom;
            let unchanged = || {
                if reencode {
                    let text = old_text();
                    let mut bytes = encode(encoding, &text).expect("UTF-8 encodes everything");
                    if bom {
                        bytes.splice(0..0, BOM.iter().copied());
                    }
                    bytes
                } else {
                    line.bytes.clone()
                }
            };
            let (bytes, change) = match pieces.map(|p| render(&p)) {
                None => (unchanged(), None),
                Some(None) => return None,
                Some(Some(bytes)) if bytes == line.bytes => (bytes, None),
                Some(Some(bytes)) => {
                    let new = if bom {
                        encoding.decode(&bytes[BOM.len()..])
                    } else {
                        encoding.decode(&bytes)
                    };
                    let old = old_text();
                    let change = (old != new).then_some(ChangedLine {
                        line: 0,
                        old: Some(old),
                        new: Some(new),
                    });
                    (bytes, change)
                }
            };
            out.push((bytes, Some(line.ending), change));
            push_inserted(&mut out, number)?;
        }

        // Endings: an inserted line takes the ending of the line before it
        // (the one after it at the very start). When the line before ends the
        // file without a line break, it gets the file's first line ending and
        // the inserted line becomes the last line instead.
        let first_ending = self
            .file
            .lines
            .iter()
            .map(|l| l.ending)
            .find(|e| *e != LineEnding::None)
            .unwrap_or(LineEnding::Lf);
        for i in 0..out.len() {
            if out[i].1.is_some() {
                continue;
            }
            let ending = if i == 0 {
                out.iter().find_map(|o| o.1).unwrap_or(first_ending)
            } else {
                let previous = out[i - 1].1.expect("set in order");
                if previous == LineEnding::None {
                    out[i - 1].1 = Some(first_ending);
                }
                previous
            };
            out[i].1 = Some(ending);
        }

        let mut changed = Vec::new();
        let mut lines = Vec::new();
        let mut deleted = deleted.into_iter().peekable();
        for (index, (bytes, ending, change)) in out.into_iter().enumerate() {
            while let Some((_, d)) = deleted.next_if(|(at, _)| *at == index) {
                changed.push(d);
            }
            if let Some(mut change) = change {
                change.line = u32::try_from(index + 1).unwrap_or(u32::MAX);
                changed.push(change);
            }
            let ending = ending.expect("every ending is set").as_bytes();
            lines.push([bytes.as_slice(), ending].concat());
        }
        changed.extend(deleted.map(|(_, d)| d));
        Some((lines, changed))
    }
}

/// Encodes `text`; `None` when a character has no encoding in `encoding`.
fn encode(encoding: TxtEncoding, text: &str) -> Option<Vec<u8>> {
    let (bytes, _, had_errors) = encoding.encoding_rs().encode(text);
    (!had_errors).then(|| bytes.into_owned())
}

fn check_text(text: &str, line: u32) -> Result<(), WriteError> {
    if text.contains(['\r', '\n']) {
        Err(WriteError::LineBreakInText { line })
    } else {
        Ok(())
    }
}

fn note_character(kind: NoteKind) -> u8 {
    match kind {
        NoteKind::Normal => b':',
        NoteKind::Golden => b'*',
        NoteKind::Rap => b'R',
        NoteKind::GoldenRap => b'G',
        NoteKind::Freestyle => b'F',
    }
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// A whole number without decimals, any other with at most 2 decimals; a
/// decimal comma when `comma` is set.
fn format_number(value: f64, comma: bool) -> String {
    let value = round2(value) + 0.0; // + 0.0 turns -0 into 0
    let text = value.to_string();
    if comma { text.replace('.', ",") } else { text }
}
