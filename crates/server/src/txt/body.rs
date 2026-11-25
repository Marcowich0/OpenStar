//! Parsing the body of a `.txt` into Voices, Lines and Notes.

use openstar_protocol::song::{Line, LineEnd, Note, NoteKind, TxtRejection, TxtWarning, Voice};

/// A non-blank body line, decoded.
pub(super) struct BodyLine {
    pub number: u32,
    pub text: String,
}

/// Parses the body lines into Voices, appending warnings in line order.
pub(super) fn parse(
    lines: Vec<BodyLine>,
    warnings: &mut Vec<TxtWarning>,
) -> Result<Vec<Voice>, TxtRejection> {
    let mut voices: [VoiceBuilder; 2] = Default::default();
    let mut current = 0;
    let mut duet = false;

    for line in lines {
        let number = line.number;
        let text = line.text.trim_start_matches(SEPARATORS);
        let mut chars = text.chars();
        let Some(first) = chars.next() else {
            continue;
        };
        let rest = chars.as_str();

        if let Some(kind) = note_kind(first) {
            let mut note =
                note(kind, rest, number).ok_or(TxtRejection::InvalidNoteLine { line: number })?;
            if note.length < 1 {
                note.kind = NoteKind::Freestyle;
                warnings.push(TxtWarning::ZeroLengthNote { line: number });
            }
            if let Some(earlier_line) = voices[current].overlapped_by(&note) {
                warnings.push(TxtWarning::OverlappingNotes {
                    line: number,
                    earlier_line,
                });
            }
            voices[current].push(note);
            continue;
        }

        let first_field = fields(rest).next().and_then(|f| f.parse::<i32>().ok());
        match (first, first_field) {
            ('-', Some(beat)) => voices[current].end_line(LineEnd { beat, line: number }),
            ('P', Some(1)) => (duet, current) = (true, 0),
            ('P', Some(2)) => (duet, current) = (true, 1),
            ('P', Some(_)) => return Err(TxtRejection::InvalidVoice { line: number }),
            _ => warnings.push(TxtWarning::UnknownBodyLine { line: number }),
        }
    }

    let [p1, p2] = voices.map(VoiceBuilder::finish);
    if !duet {
        return if p1.lines.is_empty() {
            Err(TxtRejection::NoNotes)
        } else {
            Ok(vec![p1])
        };
    }
    if p1.lines.is_empty() && p2.lines.is_empty() {
        return Err(TxtRejection::NoNotes);
    }
    for (voice, number) in [(&p1, 1), (&p2, 2)] {
        if voice.lines.is_empty() {
            return Err(TxtRejection::DuetVoiceWithoutNotes { voice: number });
        }
    }
    Ok(vec![p1, p2])
}

const SEPARATORS: [char; 2] = [' ', '\t'];

fn note_kind(c: char) -> Option<NoteKind> {
    Some(match c {
        ':' => NoteKind::Normal,
        '*' => NoteKind::Golden,
        'R' => NoteKind::Rap,
        'G' => NoteKind::GoldenRap,
        'F' => NoteKind::Freestyle,
        _ => return None,
    })
}

/// The fields of `text` separated by runs of spaces or tabs.
fn fields(text: &str) -> impl Iterator<Item = &str> {
    text.split(SEPARATORS).filter(|f| !f.is_empty())
}

/// Parses `start length pitch text` (the part after the type character).
/// `None` when start, length or pitch is not an integer.
fn note(kind: NoteKind, rest: &str, line: u32) -> Option<Note> {
    let mut rest = rest;
    let mut number = || -> Option<i32> {
        let trimmed = rest.trim_start_matches(SEPARATORS);
        let end = trimmed.find(SEPARATORS).unwrap_or(trimmed.len());
        let value = trimmed[..end].parse().ok()?;
        rest = &trimmed[end..];
        Some(value)
    };
    let start = number()?;
    let length = number()?;
    let pitch = number()?;
    // The text is everything after the single separator following the pitch.
    let mut text = rest.chars();
    text.next();
    Some(Note {
        kind,
        start,
        length,
        pitch,
        text: text.as_str().to_owned(),
        line,
    })
}

/// The Voice being read: finished Lines plus the Notes of the open Line.
#[derive(Default)]
struct VoiceBuilder {
    lines: Vec<Line>,
    open: Vec<Note>,
}

impl VoiceBuilder {
    /// The line of the first earlier Note in this Voice that shares a beat
    /// with `note`. Notes cover `start..start + length`; a Note with a
    /// length below 1 covers no beat.
    fn overlapped_by(&self, note: &Note) -> Option<u32> {
        let covers = |n: &Note| (i64::from(n.start), i64::from(n.start) + i64::from(n.length));
        let (start, end) = covers(note);
        if start >= end {
            return None;
        }
        self.lines
            .iter()
            .flat_map(|l| &l.notes)
            .chain(&self.open)
            .find(|earlier| {
                let (earlier_start, earlier_end) = covers(earlier);
                earlier_start < earlier_end && start < earlier_end && earlier_start < end
            })
            .map(|earlier| earlier.line)
    }

    fn push(&mut self, note: Note) {
        self.open.push(note);
    }

    /// Closes the open Line. A marker with no Notes since the last one (a
    /// repeated marker, or one before the first Note) is ignored, so a Line
    /// with no Notes is dropped.
    fn end_line(&mut self, end: LineEnd) {
        if self.open.is_empty() {
            return;
        }
        self.lines.push(Line {
            notes: std::mem::take(&mut self.open),
            end: Some(end),
        });
    }

    fn finish(mut self) -> Voice {
        if !self.open.is_empty() {
            self.lines.push(Line {
                notes: self.open,
                end: None,
            });
        }
        Voice { lines: self.lines }
    }
}
