//! One scan of the Library into the index.
//!
//! Every file at any depth whose name ends in `.txt` (in any case) is a
//! candidate; `<name>.txt.orig` is not. A candidate is read and parsed only
//! when it is new, its size or mtime changed, or it was indexed by another
//! parser version; the references of every other parsed candidate are
//! resolved again. Indexed files that have gone are removed. Then the media
//! the Songs name is probed ([`probing`]), and what the Stage cannot play
//! is converted ([`conversion`]). The work runs on
//! blocking threads in small batches, so the stored index keeps being served.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use openstar_protocol::library::{FileProblem, ProblemReason, ProblemSeverity, ScanReport};
use openstar_protocol::song::{FormatGeneration, SongHeaders};

use super::index::{self, Media, ReadFile, Reference, Role, Stored};
use super::resolve::Resolver;
use super::{artwork, identity};
use super::{conversion, loudness, probing};
use crate::db::Database;
use crate::jobs::{Jobs, Slot};
use crate::txt;

/// How many files one batch reads, or re-resolves, before it is stored.
const BATCH: usize = 64;

/// A candidate `.txt` found on disk.
struct Candidate {
    /// Relative to the Library, `/` between segments.
    path: String,
    /// The folder holding it, relative to the Library.
    folder: PathBuf,
    size: i64,
    mtime_ns: i64,
}

/// Scans `root` into the index. `None` when the scan was cancelled or the
/// Library could not be listed; the index is then left as it was, apart from
/// batches already stored.
pub(crate) async fn run(
    db: &Database,
    root: &Path,
    parser_version: u32,
    slot: &Slot,
    cancelled: &Arc<AtomicBool>,
    jobs: &Jobs,
    appdata_dir: &Path,
) -> anyhow::Result<Option<ScanReport>> {
    let stored = db.call(|conn| index::load(conn)).await?;
    let walk_root = root.to_owned();
    let candidates = tokio::task::spawn_blocking(move || walk(&walk_root)).await??;

    let mut stored: std::collections::HashMap<String, Stored> = stored.into_iter().collect();
    let mut to_read = Vec::new();
    let mut unchanged = Vec::new();
    for candidate in candidates {
        match stored.remove(&candidate.path) {
            Some(entry)
                if entry.size == candidate.size
                    && entry.mtime_ns == candidate.mtime_ns
                    && entry.parser_version == parser_version =>
            {
                if entry.parsed {
                    unchanged.push((candidate, entry.references));
                } else {
                    unchanged.push((candidate, Vec::new()));
                }
            }
            _ => to_read.push(candidate),
        }
    }
    let gone: Vec<i64> = stored.values().map(|entry| entry.id).collect();
    let mut report = ScanReport {
        read: count(to_read.len()),
        unchanged: count(unchanged.len()),
        removed: count(gone.len()),
        probed: 0,
    };

    for batch in chunks(to_read) {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let root = root.to_owned();
        let files = tokio::task::spawn_blocking(move || {
            let mut resolver = Resolver::new(&root);
            batch
                .into_iter()
                .map(|candidate| read(&root, &mut resolver, candidate))
                .collect::<Vec<_>>()
        })
        .await?;
        db.call(move |conn| {
            let tx = conn.transaction()?;
            index::store_read(&tx, &files, parser_version)?;
            tx.commit()
        })
        .await?;
    }

    let parsed: Vec<_> = unchanged
        .into_iter()
        .filter(|(_, references)| !references.is_empty())
        .collect();
    for batch in chunks(parsed) {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let root = root.to_owned();
        let resolved = tokio::task::spawn_blocking(move || {
            let mut resolver = Resolver::new(&root);
            batch
                .into_iter()
                .map(|(candidate, references)| {
                    let media = resolve(&mut resolver, &candidate.folder, references);
                    (candidate.path, media)
                })
                .collect::<Vec<_>>()
        })
        .await?;
        db.call(move |conn| {
            let tx = conn.transaction()?;
            for (path, media) in &resolved {
                index::store_media(&tx, path, true, media)?;
            }
            tx.commit()
        })
        .await?;
    }

    if cancelled.load(Ordering::Relaxed) {
        return Ok(None);
    }
    db.call(move |conn| {
        let tx = conn.transaction()?;
        index::remove(&tx, &gone)?;
        tx.commit()
    })
    .await?;
    let probed = match probing::run(db, root, slot, cancelled).await? {
        Some(probed) => probed,
        None => return Ok(None),
    };
    report.probed = count(probed.len());
    conversion::sync(db, jobs, appdata_dir, probed).await?;
    loudness::sync(db, jobs, root).await?;
    Ok(Some(report))
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn chunks<T>(items: Vec<T>) -> Vec<Vec<T>> {
    let mut batches = Vec::new();
    let mut items = items.into_iter().peekable();
    while items.peek().is_some() {
        batches.push(items.by_ref().take(BATCH).collect());
    }
    batches
}

/// Every candidate `.txt` under `root`. Folders reached through a symbolic
/// link are not entered (they could loop); linked files count.
fn walk(root: &Path) -> anyhow::Result<Vec<Candidate>> {
    // An unreadable Library (unmounted, say) must not empty the index.
    std::fs::read_dir(root)?;
    let mut candidates = Vec::new();
    let mut folders = vec![PathBuf::new()];
    while let Some(folder) = folders.pop() {
        let entries = match std::fs::read_dir(root.join(&folder)) {
            Ok(entries) => entries,
            Err(error) => {
                tracing::warn!(folder = %folder.display(), %error, "skipping an unreadable folder");
                continue;
            }
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let relative = folder.join(&name);
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                folders.push(relative);
                continue;
            }
            if !name.to_string_lossy().to_lowercase().ends_with(".txt") {
                continue;
            }
            // Follows a symbolic link to its file.
            let Ok(metadata) = std::fs::metadata(entry.path()) else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            candidates.push(Candidate {
                path: slash_path(&relative),
                folder: folder.clone(),
                size: i64::try_from(metadata.len()).unwrap_or(i64::MAX),
                mtime_ns: mtime_ns(&metadata),
            });
        }
    }
    candidates.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(candidates)
}

fn slash_path(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

pub(super) fn mtime_ns(metadata: &std::fs::Metadata) -> i64 {
    let Ok(modified) = metadata.modified() else {
        return 0;
    };
    match modified.duration_since(UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_nanos()).unwrap_or(i64::MAX),
        Err(before) => -i64::try_from(before.duration().as_nanos()).unwrap_or(i64::MAX),
    }
}

/// Reads, parses and resolves one candidate.
fn read(root: &Path, resolver: &mut Resolver, candidate: Candidate) -> ReadFile {
    let mut file = ReadFile {
        path: candidate.path,
        size: candidate.size,
        mtime_ns: candidate.mtime_ns,
        encoding: None,
        song: None,
        txt_problems: Vec::new(),
        media: Media::default(),
    };
    let bytes = match std::fs::read(root.join(&file.path)) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(path = %file.path, %error, "reading a .txt");
            file.txt_problems.push((
                ProblemSeverity::Rejection,
                ProblemReason::File(FileProblem::UnreadableFile),
            ));
            return file;
        }
    };
    let folder_name = candidate
        .folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    match txt::parse(&bytes, &folder_name) {
        Ok(parsed) => {
            file.encoding = Some(parsed.encoding.name());
            file.txt_problems = parsed
                .warnings
                .into_iter()
                .map(|w| (ProblemSeverity::Warning, ProblemReason::Warning(w)))
                .collect();
            file.media = resolve(
                resolver,
                &candidate.folder,
                references(&parsed.song.headers),
            );
            file.song = Some(parsed.song);
        }
        Err(rejection) => {
            file.encoding = Some(txt::detect_encoding(&bytes).name());
            file.txt_problems = vec![(
                ProblemSeverity::Rejection,
                ProblemReason::Rejection(rejection),
            )];
        }
    }
    file
}

/// The file references a `.txt`'s headers name. The audio reference comes
/// from `#AUDIO` or `#MP3` by the generation's rule.
pub(crate) fn references(headers: &SongHeaders) -> Vec<Reference> {
    let mut references = Vec::new();
    if let Some(value) = &headers.audio_reference {
        let from_audio = headers.audio.as_ref() == Some(value)
            && (headers.generation == FormatGeneration::V1 || headers.mp3.is_none());
        references.push(Reference {
            role: Role::Audio,
            header: if from_audio { "AUDIO" } else { "MP3" },
            value: value.clone(),
        });
    }
    let others = [
        (Role::Video, "VIDEO", &headers.video),
        (Role::Cover, "COVER", &headers.cover),
        (Role::Background, "BACKGROUND", &headers.background),
        (Role::Vocals, "VOCALS", &headers.vocals),
        (Role::Instrumental, "INSTRUMENTAL", &headers.instrumental),
    ];
    for (role, header, value) in others {
        if let Some(value) = value {
            references.push(Reference {
                role,
                header,
                value: value.clone(),
            });
        }
    }
    references
}

/// Resolves the references of a parsed `.txt` in `folder`. No audio
/// reference, or audio not found, is a rejection; a video, cover or
/// background not found is a warning.
fn resolve(resolver: &mut Resolver, folder: &Path, references: Vec<Reference>) -> Media {
    let mut media = Media::default();
    if !references.iter().any(|r| r.role == Role::Audio) {
        media.problems.push((
            ProblemSeverity::Rejection,
            ProblemReason::File(FileProblem::MissingAudioReference),
        ));
    }
    for reference in &references {
        match resolver.resolve(folder, &reference.value) {
            Some(path) => media.resolved.push((reference.role, path)),
            None => {
                let header = reference.header.to_owned();
                let value = reference.value.clone();
                let problem = match reference.role {
                    Role::Audio => Some((
                        ProblemSeverity::Rejection,
                        FileProblem::AudioNotFound {
                            header,
                            reference: value,
                        },
                    )),
                    Role::Video | Role::Cover | Role::Background => Some((
                        ProblemSeverity::Warning,
                        FileProblem::MediaNotFound {
                            header,
                            reference: value,
                        },
                    )),
                    // The spec names no problem for these.
                    Role::Vocals | Role::Instrumental => None,
                };
                if let Some((severity, problem)) = problem {
                    media
                        .problems
                        .push((severity, ProblemReason::File(problem)));
                }
            }
        }
    }
    media.references = references;
    media.usdb_id = read_usdb_id(resolver, folder, &mut media);
    choose_artwork(resolver, folder, &mut media);
    media
}

/// The cover and background by the fallback rules (see [`artwork`]). A
/// `#COVER` or `#BACKGROUND` that names something other than an image is
/// passed over.
fn choose_artwork(resolver: &mut Resolver, folder: &Path, media: &mut Media) {
    let header = |role: Role| {
        media
            .resolved
            .iter()
            .find(|(r, path)| *r == role && artwork::is_image(path))
            .map(|(_, path)| path.clone())
    };
    let images: Vec<String> = resolver
        .names(folder)
        .into_iter()
        .filter(|name| artwork::is_image(name))
        .filter(|name| resolver.resolve(folder, name).is_some())
        .collect();
    media.cover = match header(Role::Cover) {
        Some(path) => Some(path),
        None => artwork::cover(None, &images).and_then(|name| resolver.resolve(folder, name)),
    };
    media.background = header(Role::Background).or_else(|| media.cover.clone());
}

/// The USDB id from the `metadata.json` in `folder`, if there is one. An
/// unreadable one is a warning, and the Song is identified without it.
fn read_usdb_id(resolver: &mut Resolver, folder: &Path, media: &mut Media) -> Option<u32> {
    let path = resolver.resolve(folder, identity::METADATA_FILE)?;
    let read = std::fs::read(resolver.root().join(&path))
        .map_err(|error| tracing::warn!(%path, %error, "reading a metadata.json"))
        .and_then(|bytes| {
            identity::usdb_id(&bytes)
                .map_err(|_| tracing::warn!(%path, "a metadata.json without a usable apiId"))
        });
    match read {
        Ok(usdb_id) => usdb_id,
        Err(()) => {
            media.problems.push((
                ProblemSeverity::Warning,
                ProblemReason::File(FileProblem::UnreadableMetadata),
            ));
            None
        }
    }
}
