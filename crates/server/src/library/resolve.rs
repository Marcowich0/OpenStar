//! Resolving a file reference from a `.txt` header (`#MP3`, `#COVER`, …).
//!
//! A reference is relative to the folder holding the `.txt`. Every path
//! segment matches case-insensitively, because Libraries built on Windows
//! have mismatched case (an exact match wins over a case-insensitive one).
//! `/` and `\` both separate segments. A reference that is absolute, or that
//! resolves outside the Library (through `..` or a symbolic link), is not found.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Resolves references under one Library, caching each folder's listing.
/// Make a new one per scan step: the cache never notices changes.
pub(crate) struct Resolver {
    root: PathBuf,
    /// The Library's canonical path, to catch symbolic links leading out.
    canonical_root: Option<PathBuf>,
    listings: HashMap<PathBuf, Option<Vec<OsString>>>,
}

impl Resolver {
    pub(crate) fn new(root: &Path) -> Self {
        Self {
            root: root.to_owned(),
            canonical_root: std::fs::canonicalize(root).ok(),
            listings: HashMap::new(),
        }
    }

    /// The Library's folder.
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// The file `reference` names, as a path relative to the Library with
    /// `/` between segments, or `None` when it is not found.
    /// `txt_folder` is the folder holding the `.txt`, relative to the Library.
    pub(crate) fn resolve(&mut self, txt_folder: &Path, reference: &str) -> Option<String> {
        if is_absolute(reference) {
            return None;
        }
        let mut segments: Vec<OsString> = txt_folder
            .components()
            .map(|c| c.as_os_str().to_owned())
            .collect();
        for segment in reference.split(['/', '\\']) {
            match segment {
                "" | "." => {}
                ".." => {
                    // Leaving the Library: not found.
                    segments.pop()?;
                }
                name => {
                    let folder: PathBuf = segments.iter().collect();
                    let found = self.find(&folder, name)?;
                    segments.push(found);
                }
            }
        }
        let relative: PathBuf = segments.iter().collect();
        let absolute = self.root.join(&relative);
        if !absolute.is_file() {
            return None;
        }
        let canonical = std::fs::canonicalize(&absolute).ok()?;
        if !canonical.starts_with(self.canonical_root.as_ref()?) {
            return None;
        }
        Some(
            segments
                .iter()
                .map(|s| s.to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
        )
    }

    /// The entry of `folder` named `name`: exactly, else ignoring case.
    fn find(&mut self, folder: &Path, name: &str) -> Option<OsString> {
        let root = &self.root;
        let listing = self
            .listings
            .entry(folder.to_owned())
            .or_insert_with(|| {
                std::fs::read_dir(root.join(folder)).ok().map(|entries| {
                    entries
                        .filter_map(|e| e.ok().map(|e| e.file_name()))
                        .collect()
                })
            })
            .as_ref()?;
        if let Some(exact) = listing.iter().find(|entry| entry.as_os_str() == name) {
            return Some(exact.clone());
        }
        let wanted = name.to_lowercase();
        listing
            .iter()
            .find(|entry| entry.to_string_lossy().to_lowercase() == wanted)
            .cloned()
    }
}

/// `/x`, `\x`, `C:\x` or `C:x`.
fn is_absolute(reference: &str) -> bool {
    let bytes = reference.as_bytes();
    reference.starts_with(['/', '\\'])
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tree {
        dir: tempfile::TempDir,
    }

    impl Tree {
        /// A temporary folder holding `library/` and the files given,
        /// relative to that folder.
        fn new(files: &[&str]) -> Self {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir(dir.path().join("library")).unwrap();
            for file in files {
                let path = dir.path().join(file);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, b"").unwrap();
            }
            Self { dir }
        }

        fn library(&self) -> PathBuf {
            self.dir.path().join("library")
        }

        fn resolve(&self, txt_folder: &str, reference: &str) -> Option<String> {
            Resolver::new(&self.library()).resolve(Path::new(txt_folder), reference)
        }
    }

    #[test]
    fn a_reference_is_relative_to_the_txt_folder() {
        let tree = Tree::new(&["library/A - B/song.mp3"]);
        assert_eq!(
            tree.resolve("A - B", "song.mp3").as_deref(),
            Some("A - B/song.mp3")
        );
        assert_eq!(tree.resolve("", "song.mp3"), None);
    }

    #[test]
    fn every_segment_matches_case_insensitively() {
        let tree = Tree::new(&["library/A - B/Media/Ünï Song.MP3"]);
        assert_eq!(
            tree.resolve("A - B", "mEDIA/üNÏ song.mp3").as_deref(),
            Some("A - B/Media/Ünï Song.MP3")
        );
        assert_eq!(
            tree.resolve("A - B", "media\\ünï song.mp3").as_deref(),
            Some("A - B/Media/Ünï Song.MP3")
        );
    }

    #[test]
    fn an_exact_match_wins_over_one_in_other_case() {
        let tree = Tree::new(&["library/x/Song.mp3", "library/x/song.mp3"]);
        assert_eq!(tree.resolve("x", "song.mp3").as_deref(), Some("x/song.mp3"));
        assert_eq!(tree.resolve("x", "Song.mp3").as_deref(), Some("x/Song.mp3"));
    }

    #[test]
    fn dot_dot_may_move_within_the_library() {
        let tree = Tree::new(&["library/shared/a.mp3"]);
        assert_eq!(
            tree.resolve("songs/one", "../../Shared/A.mp3").as_deref(),
            Some("shared/a.mp3")
        );
    }

    #[test]
    fn a_reference_leaving_the_library_is_not_found() {
        let tree = Tree::new(&["outside.mp3", "library/x/in.mp3"]);
        assert_eq!(tree.resolve("x", "../../outside.mp3"), None);
        assert_eq!(tree.resolve("", "../outside.mp3"), None);
    }

    #[test]
    fn an_absolute_reference_is_not_found() {
        let tree = Tree::new(&["library/x/in.mp3"]);
        let absolute = tree.library().join("x/in.mp3");
        assert_eq!(tree.resolve("x", absolute.to_str().unwrap()), None);
        assert_eq!(tree.resolve("x", "\\x\\in.mp3"), None);
        assert_eq!(tree.resolve("x", "C:\\x\\in.mp3"), None);
    }

    #[test]
    fn a_folder_or_a_missing_file_is_not_found() {
        let tree = Tree::new(&["library/x/sub/in.mp3"]);
        assert_eq!(tree.resolve("x", "sub"), None);
        assert_eq!(tree.resolve("x", "nothing.mp3"), None);
        assert_eq!(tree.resolve("x", "in.mp3/more"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_leading_out_of_the_library_is_not_found() {
        let tree = Tree::new(&["outside.mp3", "library/x/in.mp3"]);
        std::os::unix::fs::symlink(
            tree.dir.path().join("outside.mp3"),
            tree.library().join("x/link.mp3"),
        )
        .unwrap();
        assert_eq!(tree.resolve("x", "link.mp3"), None);
    }
}
