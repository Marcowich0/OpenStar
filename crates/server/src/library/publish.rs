//! Writing a new Song folder into the Library safely (see
//! [`super::Scanner::publish`]): its files are written into a temporary
//! folder under `/appdata` ([`NewSongFolder`]), never inside the Library, so
//! neither OpenStar's scan nor UltraStar Deluxe sees half-finished files.
//! Only the finished folder is moved in, under a name no existing folder
//! has ([`folder_name`], [`move_in`]).

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Where new Song folders are written before they move into the Library,
/// relative to `/appdata`.
const STAGING_DIR: &str = "tmp/new-songs";

/// A temporary folder under `/appdata/tmp/new-songs` that a new Song's files
/// are written into. Dropping it (unpublished, or after a failed publish)
/// removes it with everything in it; nothing else is ever removed.
#[derive(Debug)]
pub(crate) struct NewSongFolder {
    path: PathBuf,
}

impl NewSongFolder {
    /// Creates an empty one. Blocks on the filesystem.
    pub(crate) fn create(appdata_dir: &Path) -> io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let staging = appdata_dir.join(STAGING_DIR);
        std::fs::create_dir_all(&staging)?;
        loop {
            let path = staging.join(NEXT.fetch_add(1, Ordering::Relaxed).to_string());
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
    }

    /// The folder to write the Song's files into.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Moves the folder into `songs` (see [`move_in`]); the temporary folder
    /// is removed whatever the outcome. Blocks on the filesystem.
    pub(crate) fn move_in(self, songs: &Path, base: &str) -> io::Result<String> {
        move_in(&self.path, songs, base, Move::Rename)
    }
}

impl Drop for NewSongFolder {
    fn drop(&mut self) {
        match std::fs::remove_dir_all(&self.path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                tracing::warn!(path = %self.path.display(), %error, "removing a temporary Song folder");
            }
            _ => {}
        }
    }
}

/// Removes the temporary folders a stop left behind (a Download interrupted
/// by a restart starts again from scratch). Run at start, before anything
/// can create one.
pub(crate) fn clear_staging(appdata_dir: &Path) {
    match std::fs::remove_dir_all(appdata_dir.join(STAGING_DIR)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => {
            tracing::warn!(%error, "removing the temporary Song folders left by the last run");
        }
        _ => {}
    }
}

/// The longest folder name OpenStar makes, in bytes, before a ` (n)`: most
/// filesystems allow 255.
const MAX_NAME_BYTES: usize = 200;

/// `Artist - Title`, with `/ \ : * ? " < > |` and control characters each
/// replaced by `_`, cut to [`MAX_NAME_BYTES`], and trailing dots and spaces
/// trimmed (Windows drops them, so a share would show another name).
pub(crate) fn folder_name(artist: &str, title: &str) -> String {
    let mut name = String::new();
    for c in format!("{artist} - {title}").chars() {
        let c = if c.is_control() || "/\\:*?\"<>|".contains(c) {
            '_'
        } else {
            c
        };
        if name.len() + c.len_utf8() > MAX_NAME_BYTES {
            break;
        }
        name.push(c);
    }
    name.trim_end_matches(['.', ' ']).to_owned()
}

/// How the finished folder goes into the Library.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Move {
    /// A rename, or a copy when `/appdata` and the Library are different
    /// filesystems.
    Rename,
    /// Always a copy (what a rename falls back to across filesystems).
    #[cfg_attr(not(test), expect(dead_code))]
    Copy,
}

/// Moves the finished folder `staging` into `songs` under `base`, or
/// `base (2)`, `base (3)` … when that name is taken, and returns the name
/// used. The name is claimed by creating an empty folder, which fails when
/// anything of that name exists, so nothing is ever written into an
/// existing folder. A rename then replaces the empty claim with the whole
/// folder at once; across filesystems the files are copied in, every `.txt`
/// last, so no scan sees a `.txt` before its media. On failure only what
/// this call made in the Library (the claim and the files it copied) is
/// removed again; `staging` is left for the caller to remove.
pub(crate) fn move_in(staging: &Path, songs: &Path, base: &str, how: Move) -> io::Result<String> {
    let (name, target) = claim(songs, base)?;
    let moved = match how {
        Move::Rename => match std::fs::rename(staging, &target) {
            Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
                copy_in(staging, &target)
            }
            other => other,
        },
        Move::Copy => copy_in(staging, &target),
    };
    match moved {
        Ok(()) => Ok(name),
        Err(error) => {
            // Fails, and so keeps it, when something else wrote into it.
            let _ = std::fs::remove_dir(&target);
            Err(error)
        }
    }
}

/// Creates the first free folder of `base`, `base (2)`, `base (3)` … in `songs`.
fn claim(songs: &Path, base: &str) -> io::Result<(String, PathBuf)> {
    for n in 1u32.. {
        let name = if n == 1 {
            base.to_owned()
        } else {
            format!("{base} ({n})")
        };
        let target = songs.join(&name);
        match std::fs::create_dir(&target) {
            Ok(()) => return Ok((name, target)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    unreachable!("a free name is found before u32 runs out")
}

/// Copies the files of `staging` (at any depth) into the empty `target`,
/// every `.txt` last. On failure the files and folders copied so far are
/// removed again (never `target` itself, see [`move_in`]).
pub(super) fn copy_in(staging: &Path, target: &Path) -> io::Result<()> {
    let mut files = Vec::new();
    let mut folders = Vec::new();
    list(staging, PathBuf::new(), &mut files, &mut folders)?;
    files.sort_by_key(|file| is_txt(file));
    let mut made_folders: Vec<PathBuf> = Vec::new();
    let mut copied: Vec<PathBuf> = Vec::new();
    let result = (|| {
        for folder in &folders {
            std::fs::create_dir(target.join(folder))?;
            made_folders.push(target.join(folder));
        }
        for file in &files {
            let to = target.join(file);
            // Removed on failure even when only partly written.
            copied.push(to.clone());
            std::fs::copy(staging.join(file), &to)?;
            std::fs::File::open(&to)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        for file in copied.iter().rev() {
            let _ = std::fs::remove_file(file);
        }
        for folder in made_folders.iter().rev() {
            let _ = std::fs::remove_dir(folder);
        }
    }
    result
}

/// The files and folders below `root.join(relative)`, relative to `root`;
/// folders before what they hold.
fn list(
    root: &Path,
    relative: PathBuf,
    files: &mut Vec<PathBuf>,
    folders: &mut Vec<PathBuf>,
) -> io::Result<()> {
    for entry in std::fs::read_dir(root.join(&relative))? {
        let entry = entry?;
        let path = relative.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            folders.push(path.clone());
            list(root, path, files, folders)?;
        } else {
            files.push(path);
        }
    }
    Ok(())
}

fn is_txt(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("txt"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn staged(dir: &Path) -> PathBuf {
        let staging = dir.join("staging");
        std::fs::create_dir_all(staging.join("extras")).unwrap();
        std::fs::write(staging.join("song.txt"), b"text").unwrap();
        std::fs::write(staging.join("song.mp3"), b"audio").unwrap();
        std::fs::write(staging.join("extras/notes.TXT"), b"notes").unwrap();
        staging
    }

    /// Every file below `dir`, relative, with its content.
    fn files(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let (mut files, mut folders) = (Vec::new(), Vec::new());
        list(dir, PathBuf::new(), &mut files, &mut folders).unwrap();
        let mut files: Vec<_> = files
            .into_iter()
            .map(|f| {
                (
                    f.to_string_lossy().into_owned(),
                    std::fs::read(dir.join(&f)).unwrap(),
                )
            })
            .collect();
        files.sort();
        files
    }

    fn expected() -> Vec<(String, Vec<u8>)> {
        vec![
            ("extras/notes.TXT".into(), b"notes".to_vec()),
            ("song.mp3".into(), b"audio".to_vec()),
            ("song.txt".into(), b"text".to_vec()),
        ]
    }

    #[test]
    fn the_folder_moves_in_whole_under_a_free_name() {
        for how in [Move::Rename, Move::Copy] {
            let dir = tempfile::tempdir().unwrap();
            let songs = dir.path().join("songs");
            std::fs::create_dir(&songs).unwrap();
            let staging = staged(dir.path());
            assert_eq!(move_in(&staging, &songs, "A - B", how).unwrap(), "A - B");
            assert_eq!(files(&songs.join("A - B")), expected(), "{how:?}");
            if how == Move::Rename {
                assert!(!staging.exists());
            }
        }
    }

    #[test]
    fn a_taken_name_gets_a_number_and_the_taken_folder_is_left_alone() {
        for how in [Move::Rename, Move::Copy] {
            let dir = tempfile::tempdir().unwrap();
            let songs = dir.path().join("songs");
            std::fs::create_dir_all(songs.join("A - B")).unwrap();
            std::fs::write(songs.join("A - B/song.txt"), b"old").unwrap();
            // An empty folder and a plain file take a name too.
            std::fs::create_dir(songs.join("A - B (2)")).unwrap();
            std::fs::write(songs.join("A - B (3)"), b"").unwrap();
            let staging = staged(dir.path());
            assert_eq!(
                move_in(&staging, &songs, "A - B", how).unwrap(),
                "A - B (4)"
            );
            assert_eq!(
                files(&songs.join("A - B")),
                vec![("song.txt".into(), b"old".to_vec())]
            );
            assert!(files(&songs.join("A - B (2)")).is_empty());
            assert_eq!(files(&songs.join("A - B (4)")), expected());
        }
    }

    #[test]
    fn a_copy_that_fails_midway_leaves_the_library_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let songs = dir.path().join("songs");
        std::fs::create_dir_all(songs.join("Old")).unwrap();
        std::fs::write(songs.join("Old/x.txt"), b"old").unwrap();
        let before = files(&songs);
        let staging = staged(dir.path());
        // A link to nothing cannot be copied; other media may be copied before it.
        std::fs::write(staging.join("a.mp3"), b"a").unwrap();
        std::os::unix::fs::symlink(dir.path().join("nothing"), staging.join("z.mp3")).unwrap();

        assert!(move_in(&staging, &songs, "A - B", Move::Copy).is_err());
        assert_eq!(files(&songs), before);
        assert_eq!(std::fs::read_dir(&songs).unwrap().count(), 1);
    }

    #[test]
    fn a_copy_writes_every_txt_last() {
        let (mut files, mut folders) = (Vec::new(), Vec::new());
        let dir = tempfile::tempdir().unwrap();
        let staging = staged(dir.path());
        list(&staging, PathBuf::new(), &mut files, &mut folders).unwrap();
        files.sort_by_key(|file| is_txt(file));
        let txt: Vec<bool> = files.iter().map(|f| is_txt(f)).collect();
        assert_eq!(txt, vec![false, true, true]);
    }

    #[test]
    fn the_folder_is_named_artist_dash_title() {
        assert_eq!(folder_name("The Band", "Song"), "The Band - Song");
    }

    #[test]
    fn illegal_and_control_characters_become_underscores() {
        assert_eq!(
            folder_name("AC/DC", "Wh\\at: *?\"<>|\u{7}\u{1b}\u{9f}"),
            "AC_DC - Wh_at_ _________"
        );
    }

    #[test]
    fn trailing_dots_and_spaces_are_trimmed() {
        assert_eq!(folder_name("Artist", "Title. . "), "Artist - Title");
        assert_eq!(folder_name("...", "..."), "... -");
    }

    #[test]
    fn a_long_name_is_cut_at_a_character() {
        let name = folder_name("Ä", &"ö".repeat(300));
        assert!(name.len() <= MAX_NAME_BYTES);
        assert!(name.len() > MAX_NAME_BYTES - 2);
        assert!(name.starts_with("Ä - öö"));
    }
}
