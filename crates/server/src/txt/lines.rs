//! The lossless line model: every physical line of a `.txt` with its own
//! bytes and its own line ending, so the writer can patch single lines and
//! leave the rest byte-identical.

/// How a line ends in the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    CrLf,
    Cr,
    /// The last line of a file that does not end with a line break.
    None,
}

impl LineEnding {
    pub fn as_bytes(self) -> &'static [u8] {
        match self {
            LineEnding::Lf => b"\n",
            LineEnding::CrLf => b"\r\n",
            LineEnding::Cr => b"\r",
            LineEnding::None => b"",
        }
    }
}

/// What a line is in the file's structure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    /// Empty or whitespace-only; skipped wherever it is.
    Blank,
    /// A `#` line before the body, interpreted or kept as an unknown header.
    Header,
    /// A non-blank line of the body, kept raw: Note lines, Line end markers,
    /// Voice changes and unknown lines.
    Body,
    /// The `E` line that ends the body.
    End,
    /// Anything after the `E` line; ignored.
    AfterEnd,
}

/// One physical line of the file.
#[derive(Clone, PartialEq, Eq)]
pub struct Line {
    /// 1-based line number, as reported in warnings and rejections.
    pub number: u32,
    /// The line's bytes without its line ending.
    pub bytes: Vec<u8>,
    pub ending: LineEnding,
    pub kind: LineKind,
}

/// Shows the raw bytes, with every non-ASCII byte escaped (`\xE9`), so a
/// snapshot pins the bytes whatever the file's encoding.
impl std::fmt::Debug for Line {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{:>3} {:?} \"{}\" {:?}",
            self.number,
            self.kind,
            self.bytes.escape_ascii(),
            self.ending
        )
    }
}

/// Splits `bytes` at CR, LF and CRLF. Concatenating each line's bytes and
/// ending gives back `bytes` exactly. A final line break does not start an
/// extra empty line.
pub(super) fn split(bytes: &[u8]) -> Vec<(Vec<u8>, LineEnding)> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let ending = match bytes[i] {
            b'\n' => LineEnding::Lf,
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => LineEnding::CrLf,
            b'\r' => LineEnding::Cr,
            _ => {
                i += 1;
                continue;
            }
        };
        lines.push((bytes[start..i].to_vec(), ending));
        i += ending.as_bytes().len();
        start = i;
    }
    if start < bytes.len() {
        lines.push((bytes[start..].to_vec(), LineEnding::None));
    }
    lines
}
