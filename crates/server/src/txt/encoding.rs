//! Detecting a `.txt` file's text encoding, once per file, before parsing.
//!
//! The order is fixed: a UTF-8 BOM, then a 1.x `#VERSION` (always UTF-8),
//! then `#ENCODING` in an unversioned file, then UTF-8 if the whole file is
//! valid UTF-8, else the single-byte encoding `chardetng` guesses (CP1252 when
//! the guess is neither CP1252 nor CP1250). `#VERSION` and `#ENCODING` are
//! read from the raw bytes, since both are ASCII.

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, UTF_8, WINDOWS_1250, WINDOWS_1252};

use super::{headers, lines::LineEnding};

/// The UTF-8 byte order mark.
pub(super) const BOM: &[u8] = b"\xEF\xBB\xBF";

/// A text encoding OpenStar reads and writes `.txt` files in. The detected
/// encoding is stored in the index and used for every write to that file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TxtEncoding {
    Utf8,
    /// Windows-1252 (Western European).
    Cp1252,
    /// Windows-1250 (Central European).
    Cp1250,
}

impl TxtEncoding {
    /// The canonical name, as `#ENCODING` spells it and the index stores it.
    pub fn name(self) -> &'static str {
        match self {
            TxtEncoding::Utf8 => "UTF8",
            TxtEncoding::Cp1252 => "CP1252",
            TxtEncoding::Cp1250 => "CP1250",
        }
    }

    /// Reads an encoding name the way `#ENCODING` is matched: dashes removed,
    /// case ignored, surrounding whitespace trimmed. `None` for any other name
    /// (including `LOCALE` and `AUTO`).
    pub fn from_name(name: &str) -> Option<Self> {
        let name: String = name
            .trim()
            .chars()
            .filter(|c| *c != '-')
            .collect::<String>()
            .to_ascii_uppercase();
        match name.as_str() {
            "UTF8" => Some(TxtEncoding::Utf8),
            "CP1252" => Some(TxtEncoding::Cp1252),
            "CP1250" => Some(TxtEncoding::Cp1250),
            _ => None,
        }
    }

    /// The `encoding_rs` encoding for decoding and encoding.
    pub fn encoding_rs(self) -> &'static Encoding {
        match self {
            TxtEncoding::Utf8 => UTF_8,
            TxtEncoding::Cp1252 => WINDOWS_1252,
            TxtEncoding::Cp1250 => WINDOWS_1250,
        }
    }

    /// Decodes one line's bytes (without a BOM). Invalid sequences become
    /// U+FFFD; the single-byte encodings decode every byte.
    pub(super) fn decode(self, bytes: &[u8]) -> String {
        self.encoding_rs()
            .decode_without_bom_handling(bytes)
            .0
            .into_owned()
    }
}

/// Detects the encoding of a whole file from its bytes and its split lines.
/// Returns the encoding and whether the file starts with a UTF-8 BOM.
pub(super) fn detect(bytes: &[u8], lines: &[(Vec<u8>, LineEnding)]) -> (TxtEncoding, bool) {
    if bytes.starts_with(BOM) {
        return (TxtEncoding::Utf8, true);
    }
    let hints = RawHeaders::read(lines);
    if hints
        .version
        .as_deref()
        .and_then(headers::parse_version)
        .is_some_and(|major| major == 1)
    {
        return (TxtEncoding::Utf8, false);
    }
    if hints.version.is_none()
        && let Some(encoding) = hints.encoding.as_deref().and_then(TxtEncoding::from_name)
    {
        return (encoding, false);
    }
    if std::str::from_utf8(bytes).is_ok() {
        return (TxtEncoding::Utf8, false);
    }
    (guess_single_byte(bytes), false)
}

/// The single-byte encoding `chardetng` guesses, limited to the two OpenStar
/// reads; CP1252 when the guess is anything else.
fn guess_single_byte(bytes: &[u8]) -> TxtEncoding {
    let mut detector = EncodingDetector::new(Iso2022JpDetection::Deny);
    detector.feed(bytes, true);
    let guess = detector.guess(None, Utf8Detection::Deny);
    if guess == WINDOWS_1250 {
        TxtEncoding::Cp1250
    } else {
        TxtEncoding::Cp1252
    }
}

/// `#VERSION` and `#ENCODING` read from the raw header lines, by the same
/// rules the header interpreter uses: keys case-insensitive, values trimmed,
/// an empty value absent, the last occurrence wins.
#[derive(Default)]
struct RawHeaders {
    version: Option<String>,
    encoding: Option<String>,
}

impl RawHeaders {
    fn read(lines: &[(Vec<u8>, LineEnding)]) -> Self {
        let mut found = RawHeaders::default();
        for (bytes, _) in lines {
            let line = bytes.trim_ascii();
            if line.is_empty() {
                continue;
            }
            let Some(header) = line.strip_prefix(b"#") else {
                break;
            };
            let Some(colon) = header.iter().position(|b| *b == b':') else {
                continue;
            };
            let key = header[..colon].trim_ascii();
            let value = header[colon + 1..].trim_ascii();
            if value.is_empty() {
                continue;
            }
            let value = String::from_utf8_lossy(value).into_owned();
            if key.eq_ignore_ascii_case(b"VERSION") {
                found.version = Some(value);
            } else if key.eq_ignore_ascii_case(b"ENCODING") {
                found.encoding = Some(value);
            }
        }
        found
    }
}
