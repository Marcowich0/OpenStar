//! A Song's identity, computed from its content only: the USDB id from
//! `apiId` in a `metadata.json` beside the `.txt`, otherwise the normalised
//! artist and title plus whether it is a duet. OpenStar never writes anything
//! into the Library to identify a Song.

use icu_casemap::CaseMapperBorrowed;
use icu_normalizer::ComposingNormalizerBorrowed;
use openstar_protocol::library::SongIdentity;
use serde_json::Value;

/// The name of the file beside a `.txt` that may hold its USDB id.
pub(crate) const METADATA_FILE: &str = "metadata.json";

/// The identity of a Song with these contents.
pub(crate) fn identity(
    usdb_id: Option<u32>,
    artist: &str,
    title: &str,
    duet: bool,
) -> SongIdentity {
    match usdb_id {
        Some(usdb_id) => SongIdentity::Usdb { usdb_id },
        None => SongIdentity::ArtistTitle {
            artist: normalise(artist),
            title: normalise(title),
            duet,
        },
    }
}

/// Artist or title as identities compare them: Unicode NFKC, then
/// case-folded, then trimmed with every whitespace run collapsed to one space.
pub(crate) fn normalise(text: &str) -> String {
    let composed = ComposingNormalizerBorrowed::new_nfkc().normalize(text);
    let folded = CaseMapperBorrowed::new().fold_string(&composed);
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The USDB id in a `metadata.json`'s bytes: `Ok(None)` when it holds no
/// `apiId`, `Err` when it is not a JSON object or its `apiId` is not a USDB
/// id (a positive integer, written as a number or a string of digits).
pub(crate) fn usdb_id(bytes: &[u8]) -> Result<Option<u32>, UnreadableMetadata> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| UnreadableMetadata)?;
    let Value::Object(fields) = value else {
        return Err(UnreadableMetadata);
    };
    let id = match fields.get("apiId") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Number(n)) => n.as_u64().and_then(|n| u32::try_from(n).ok()),
        Some(Value::String(s)) if s.bytes().all(|b| b.is_ascii_digit()) => s.parse().ok(),
        Some(_) => None,
    };
    match id {
        Some(id) if id > 0 => Ok(Some(id)),
        _ => Err(UnreadableMetadata),
    }
}

/// A `metadata.json` that does not give a usable answer.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct UnreadableMetadata;

/// The identity as one string, for the index to store and compare.
pub(crate) fn key(identity: &SongIdentity) -> String {
    serde_json::to_string(identity).expect("an identity encodes")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artist_title(artist: &str, title: &str, duet: bool) -> SongIdentity {
        SongIdentity::ArtistTitle {
            artist: artist.into(),
            title: title.into(),
            duet,
        }
    }

    #[test]
    fn a_usdb_id_is_the_identity() {
        assert_eq!(
            identity(Some(4711), "Artist", "Title", false),
            SongIdentity::Usdb { usdb_id: 4711 }
        );
        assert_eq!(
            identity(Some(4711), "Other", "Thing", true),
            SongIdentity::Usdb { usdb_id: 4711 }
        );
    }

    #[test]
    fn without_a_usdb_id_the_identity_is_normalised_artist_title_and_duet() {
        assert_eq!(
            identity(None, "  The   Band\t", "Some\u{a0}Song ", false),
            artist_title("the band", "some song", false)
        );
    }

    #[test]
    fn a_solo_and_a_duet_differ_and_a_usdb_id_never_meets_artist_and_title() {
        let solo = identity(None, "A", "B", false);
        let duet = identity(None, "A", "B", true);
        let usdb = identity(Some(1), "A", "B", false);
        assert_ne!(solo, duet);
        assert_ne!(key(&solo), key(&duet));
        assert_ne!(key(&usdb), key(&solo));
        assert_ne!(key(&usdb), key(&duet));
    }

    #[test]
    fn normalisation_is_nfkc_then_case_fold_then_whitespace() {
        // NFKC: the ligature and the full-width letters become plain letters,
        // a composed and a decomposed é become one.
        assert_eq!(normalise("ﬁre"), "fire");
        assert_eq!(normalise("ＡＢＣ"), "abc");
        assert_eq!(normalise("Cafe\u{301}"), normalise("Café"));
        // Case folding, not lower-casing: ß folds to ss, final sigma to σ.
        assert_eq!(normalise("Straße"), "strasse");
        assert_eq!(normalise("STRASSE"), "strasse");
        assert_eq!(normalise("ΣΟΦΟΣ"), normalise("σοφος"));
        // Whitespace: trimmed, every run (any Unicode space) collapsed.
        assert_eq!(normalise(" \t a \n\r b\u{2003} c  "), "a b c");
        assert_eq!(normalise("   "), "");
        // NFKC turns the ideographic space into a space before collapsing.
        assert_eq!(normalise("a\u{3000}\u{3000}b"), "a b");
    }

    #[test]
    fn metadata_gives_the_api_id_as_a_number_or_digits() {
        assert_eq!(usdb_id(br#"{"apiId": 12345}"#), Ok(Some(12345)));
        assert_eq!(usdb_id(br#"{"apiId": "12345", "x": 1}"#), Ok(Some(12345)));
        assert_eq!(usdb_id(br#"{"other": 1}"#), Ok(None));
        assert_eq!(usdb_id(br#"{"apiId": null}"#), Ok(None));
    }

    #[test]
    fn metadata_that_is_not_json_or_holds_no_usdb_id_is_unreadable() {
        for bytes in [
            &b""[..],
            b"not json",
            b"[1, 2]",
            br#"{"apiId": -3}"#,
            br#"{"apiId": 0}"#,
            br#"{"apiId": 1.5}"#,
            br#"{"apiId": "abc"}"#,
            br#"{"apiId": true}"#,
            br#"{"apiId": 99999999999}"#,
        ] {
            assert_eq!(
                usdb_id(bytes),
                Err(UnreadableMetadata),
                "{}",
                String::from_utf8_lossy(bytes)
            );
        }
    }
}
