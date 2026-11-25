//! A Song's cover and background, and the generated tile for a Song with
//! neither.
//!
//! Cover, first match wins: the `#COVER` file; an image whose name contains
//! `[CO]`; an image named `cover.*`; the only image in the Song's folder.
//! Background: the `#BACKGROUND` file, else the cover, else the generated
//! tile. Images are JPEG, PNG and WebP, told apart by their extension.

use openstar_protocol::library::SongIdentity;
use openstar_protocol::profile::PaletteKey;

use super::identity;

/// Whether a file name is an image the Stage shows (JPEG, PNG or WebP).
pub(crate) fn is_image(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".jpg", ".jpeg", ".png", ".webp"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// The cover among the images of the Song's folder (`images`: file names,
/// all images), given the `#COVER` file if it resolved to an image.
/// Returns the `#COVER` value or one of `images`.
pub(crate) fn cover<'a>(cover_header: Option<&'a str>, images: &'a [String]) -> Option<&'a str> {
    if let Some(header) = cover_header {
        return Some(header);
    }
    let mut sorted: Vec<&str> = images.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sorted
        .iter()
        .find(|name| name.to_uppercase().contains("[CO]"))
        .or_else(|| {
            sorted.iter().find(|name| {
                let lower = name.to_lowercase();
                lower.starts_with("cover.") && lower.len() > "cover.".len()
            })
        })
        .copied()
        .or(match sorted.as_slice() {
            [only] => Some(only),
            _ => None,
        })
}

/// The generated tile's colour: one of the twelve palette keys, from a
/// stable hash (FNV-1a) of the Song's identity, so it is the same at every
/// scan, restart and release.
pub(crate) fn tile_colour(identity: &SongIdentity) -> PaletteKey {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in identity::key(identity).bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let len = PaletteKey::ALL.len() as u64;
    PaletteKey::ALL[usize::try_from(hash % len).expect("under twelve")]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn images_are_jpeg_png_and_webp() {
        for name in ["a.jpg", "A.JPEG", "b.png", "c.WebP"] {
            assert!(is_image(name), "{name}");
        }
        for name in ["a.gif", "a.bmp", "jpg", "a.jpg.txt", "a.mp4"] {
            assert!(!is_image(name), "{name}");
        }
    }

    #[test]
    fn the_cover_header_wins() {
        let images = names(&["x [CO].jpg", "cover.png"]);
        assert_eq!(cover(Some("Front.webp"), &images), Some("Front.webp"));
    }

    #[test]
    fn then_an_image_whose_name_contains_co() {
        let images = names(&["cover.png", "A - B [co].jpg", "A - B [BG].jpg"]);
        assert_eq!(cover(None, &images), Some("A - B [co].jpg"));
    }

    #[test]
    fn then_an_image_named_cover() {
        let images = names(&["back.jpg", "Cover.JPG", "discover.png"]);
        assert_eq!(cover(None, &images), Some("Cover.JPG"));
    }

    #[test]
    fn then_the_only_image() {
        assert_eq!(cover(None, &names(&["front.webp"])), Some("front.webp"));
        assert_eq!(cover(None, &names(&["a.jpg", "b.jpg"])), None);
        assert_eq!(cover(None, &[]), None);
    }

    #[test]
    fn the_tile_colour_is_stable_and_spreads_over_the_palette() {
        let song = |n: u32| SongIdentity::Usdb { usdb_id: n };
        // Known values (FNV-1a of the identity's JSON, worked out apart from
        // this code): a change here changes every Song's colour.
        assert_eq!(tile_colour(&song(1)), PaletteKey::Cocoa);
        assert_eq!(tile_colour(&song(310)), PaletteKey::Navy);
        assert_eq!(
            tile_colour(&SongIdentity::ArtistTitle {
                artist: "a".into(),
                title: "b".into(),
                duet: false
            }),
            PaletteKey::Mint
        );
        let used: std::collections::HashSet<_> = (0..200).map(|n| tile_colour(&song(n))).collect();
        assert_eq!(used.len(), 12, "every palette key is used");
    }
}
