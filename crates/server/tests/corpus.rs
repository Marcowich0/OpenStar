//! `just corpus <path>` (`openstar corpus <path>`): every Song text under a
//! Library parsed by the Library's parser and written back with no edits, in
//! memory, compared byte for byte. Run here against the parser fixtures, the
//! fixture Library and generated placeholder Songs; a run over the owner's
//! real Library is release checklist item 1.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use openstar::corpus::{self, Outcome, Report};
use openstar_protocol::library::ProblemReason;
use openstar_protocol::song::TxtRejection;

fn fixtures(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(name)
}

fn rejected(report: &Report) -> Vec<&str> {
    report
        .files
        .iter()
        .filter(|f| matches!(f.outcome, Outcome::Rejected { .. }))
        .map(|f| f.path.as_str())
        .collect()
}

fn assert_no_crash_or_mismatch(report: &Report) {
    for file in &report.files {
        assert!(
            !matches!(
                file.outcome,
                Outcome::Crashed { .. } | Outcome::Mismatch { .. }
            ),
            "{}: {:?}",
            file.path,
            file.outcome
        );
    }
    assert_eq!(report.crashes(), 0);
    assert_eq!(report.mismatches(), 0);
    assert!(report.passed());
}

#[test]
fn the_parser_fixtures_round_trip_and_only_the_rejected_ones_are_rejected() {
    let report = corpus::run(&fixtures("txt")).unwrap();

    assert_no_crash_or_mismatch(&report);
    assert_eq!(
        rejected(&report),
        [
            "body/duet-voice-without-notes-rejected.txt",
            "body/non-integer-note-field-rejected.txt",
            "body/p3-rejected.txt",
            "headers/missing-bpm.txt",
            "headers/relative-rejected.txt",
            "headers/version-2-rejected.txt",
        ]
    );
    assert_eq!(report.songs_read(), 22);
    assert_eq!(report.rejects(), 6);
}

#[test]
fn the_fixture_library_round_trips_and_lists_its_rejected_song_with_the_reason() {
    let report = corpus::run(&fixtures("library")).unwrap();

    assert_no_crash_or_mismatch(&report);
    assert_eq!(report.songs_read(), 5);
    let rejects: Vec<_> = report
        .files
        .iter()
        .filter_map(|f| match &f.outcome {
            Outcome::Rejected { reason } => Some((f.path.as_str(), reason.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        rejects,
        [(
            "Placeholder Artist - Rejected/rejected.txt",
            ProblemReason::Rejection(TxtRejection::UnsupportedVersion { line: 1 })
        )]
    );
}

/// A placeholder Song text (placeholder lyrics only, `fixtures/README.md`).
fn placeholder_song(title: &str, ending: &str) -> Vec<u8> {
    [
        "#TITLE:".to_owned() + title,
        "#ARTIST:Placeholder Artist".to_owned(),
        "#MP3:song.mp3".to_owned(),
        "#BPM:120".to_owned(),
        "#GAP:500".to_owned(),
        ": 0 2 5 la".to_owned(),
        ": 2 2 7  la".to_owned(),
        "- 6".to_owned(),
        "* 8 4 9 la".to_owned(),
        "E".to_owned(),
    ]
    .map(|line| line + ending)
    .concat()
    .into_bytes()
}

/// A temporary Library holding `songs` (path relative to the Library → bytes).
fn library(songs: &[(&str, Vec<u8>)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (path, bytes) in songs {
        let path = dir.path().join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    dir
}

fn outcome<'a>(report: &'a Report, path: &str) -> &'a Outcome {
    &report
        .files
        .iter()
        .find(|f| f.path == path)
        .unwrap_or_else(|| panic!("{path} is not in the report: {report:?}"))
        .outcome
}

fn unedited(file: &openstar::txt::TxtFile) -> Vec<u8> {
    openstar::txt::write(file, &[]).unwrap().bytes
}

#[test]
fn generated_placeholder_songs_in_every_line_ending_and_encoding_round_trip() {
    let mut cp1252 = placeholder_song("Caf\u{e9} \u{e0} la cr\u{e8}me", "\r\n");
    while let Some(at) = cp1252.windows(2).position(|w| w[0] == 0xc3) {
        let byte = cp1252[at + 1] + 0x40;
        cp1252.splice(at..at + 2, [byte]);
    }
    let mut bom = b"\xef\xbb\xbf".to_vec();
    bom.extend(placeholder_song("Bom", "\n"));
    let mut unterminated = placeholder_song("Unterminated", "\n");
    unterminated.pop();
    let library = library(&[
        ("A - Lf/lf.txt", placeholder_song("Lf", "\n")),
        ("A - CrLf/crlf.txt", placeholder_song("CrLf", "\r\n")),
        ("A - Cr/cr.txt", placeholder_song("Cr", "\r")),
        ("A - Cp1252/cp1252.txt", cp1252),
        ("A - Bom/bom.txt", bom),
        (
            "Nested/Deeper/A - Upper/UPPER.TXT",
            placeholder_song("Upper", "\n"),
        ),
        ("A - Unterminated/unterminated.txt", unterminated),
        ("A - Lf/lf.txt.orig", b"not a Song text".to_vec()),
        ("A - Lf/notes.md", b"not a Song text".to_vec()),
    ]);

    let report = corpus::run(library.path()).unwrap();

    assert_no_crash_or_mismatch(&report);
    assert_eq!(report.songs_read(), 7, "{report:?}");
    assert_eq!(report.rejects(), 0, "{report:?}");
    assert_eq!(
        outcome(&report, "A - Cp1252/cp1252.txt"),
        &Outcome::RoundTrip {
            encoding: "CP1252",
            warnings: 0
        }
    );
}

#[test]
fn a_panic_on_one_file_is_reported_with_its_path_and_the_run_carries_on() {
    let library = library(&[
        ("A - One/one.txt", placeholder_song("One", "\n")),
        ("A - Two/two.txt", placeholder_song("Two", "\n")),
        ("A - Three/three.txt", placeholder_song("Three", "\n")),
    ]);

    let report = corpus::run_with(library.path(), |file| {
        assert!(file.song.headers.title != "Two", "the writer broke on Two");
        unedited(file)
    })
    .unwrap();

    assert_eq!(report.songs_read(), 3);
    assert_eq!(report.crashes(), 1);
    assert!(
        matches!(outcome(&report, "A - Two/two.txt"), Outcome::Crashed { message } if message.contains("the writer broke on Two")),
        "{report:?}"
    );
    assert!(matches!(
        outcome(&report, "A - Three/three.txt"),
        Outcome::RoundTrip { .. }
    ));
    assert!(!report.passed());
    let printed = report.to_string();
    assert!(printed.contains("A - Two/two.txt"), "{printed}");
    assert!(printed.contains("crashes: 1"), "{printed}");
}

#[test]
fn a_file_that_does_not_come_back_identical_is_listed_with_the_first_line_that_differs() {
    let library = library(&[
        ("A - Changed/changed.txt", placeholder_song("Changed", "\n")),
        ("A - Longer/longer.txt", placeholder_song("Longer", "\n")),
        ("A - Same/same.txt", placeholder_song("Same", "\n")),
    ]);

    let report = corpus::run_with(library.path(), |file| {
        let mut bytes = unedited(file);
        match file.song.headers.title.as_str() {
            // Line 4 is `#BPM:120`.
            "Changed" => {
                let at = bytes.windows(3).position(|w| w == b"120").unwrap();
                bytes[at] = b'9';
            }
            "Longer" => bytes.extend(b"\n"),
            _ => {}
        }
        bytes
    })
    .unwrap();

    assert_eq!(
        outcome(&report, "A - Changed/changed.txt"),
        &Outcome::Mismatch { line: 4 }
    );
    assert_eq!(
        outcome(&report, "A - Longer/longer.txt"),
        &Outcome::Mismatch { line: 11 }
    );
    assert!(matches!(
        outcome(&report, "A - Same/same.txt"),
        Outcome::RoundTrip { .. }
    ));
    assert_eq!(report.mismatches(), 2);
    assert!(!report.passed());
    let printed = report.to_string();
    assert!(
        printed.contains("A - Changed/changed.txt: first differs at line 4"),
        "{printed}"
    );
    assert!(printed.contains("mismatches: 2"), "{printed}");
}

#[test]
fn rejects_are_listed_with_their_reasons_and_do_not_fail_the_run() {
    let mut rejected = b"#VERSION:2.0.0\n".to_vec();
    rejected.extend(placeholder_song("Rejected", "\n"));
    let library = library(&[
        ("A - Good/good.txt", placeholder_song("Good", "\n")),
        ("A - Rejected/rejected.txt", rejected),
    ]);

    let report = corpus::run(library.path()).unwrap();

    assert_eq!(report.rejects(), 1);
    assert!(report.passed());
    let printed = report.to_string();
    assert!(
        printed.contains(r#"A - Rejected/rejected.txt: {"code":"unsupportedVersion","line":1}"#),
        "{printed}"
    );
    assert!(
        printed.contains("Songs read: 2, rejects: 1, crashes: 0, mismatches: 0"),
        "{printed}"
    );
}

/// Every path under `root` with its bytes (`None` for a folder) and mtime.
fn tree(root: &Path) -> BTreeMap<PathBuf, (Option<Vec<u8>>, std::time::SystemTime)> {
    let mut found = BTreeMap::new();
    let mut folders = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            let bytes = if metadata.is_dir() {
                folders.push(path.clone());
                None
            } else {
                Some(std::fs::read(&path).unwrap())
            };
            found.insert(path, (bytes, metadata.modified().unwrap()));
        }
    }
    found
}

#[test]
fn a_run_never_writes_moves_or_creates_anything_in_the_library() {
    let mut rejected = b"#VERSION:2.0.0\n".to_vec();
    rejected.extend(placeholder_song("Rejected", "\n"));
    let library = library(&[
        ("A - Good/good.txt", placeholder_song("Good", "\r\n")),
        ("A - Rejected/rejected.txt", rejected),
        ("A - Good/song.mp3", b"placeholder".to_vec()),
    ]);
    let before = tree(library.path());

    corpus::run(library.path()).unwrap();
    corpus::run_with(library.path(), |_| panic!("crash")).unwrap();
    corpus::run_with(library.path(), |_| b"different".to_vec()).unwrap();

    assert_eq!(tree(library.path()), before);
}

#[test]
fn a_library_that_cannot_be_listed_is_an_error() {
    let missing = tempfile::tempdir().unwrap().path().join("missing");
    assert!(corpus::run(&missing).is_err());
}

fn openstar_corpus(path: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_openstar"))
        .arg("corpus")
        .arg(path)
        .env_clear()
        .output()
        .unwrap()
}

#[test]
fn the_command_prints_the_report_and_exits_zero_when_every_file_round_trips() {
    let output = openstar_corpus(&fixtures("library"));
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(output.status.success(), "{output:?}");
    assert!(
        stdout.contains("Placeholder Artist - Rejected/rejected.txt"),
        "{stdout}"
    );
    assert!(
        stdout.contains("Songs read: 5, rejects: 1, crashes: 0, mismatches: 0"),
        "{stdout}"
    );
}

#[test]
fn the_command_exits_non_zero_on_a_library_it_cannot_list() {
    let missing = tempfile::tempdir().unwrap().path().join("missing");
    let output = openstar_corpus(&missing);
    assert_eq!(output.status.code(), Some(1), "{output:?}");
}

/// The recipes `ci` runs, following each recipe's dependencies.
fn recipes_run_by(justfile: &str, start: &str) -> Vec<(String, String)> {
    let mut recipes = BTreeMap::new();
    let mut current: Option<(String, String, String)> = None;
    for line in justfile.lines() {
        let header =
            !line.starts_with([' ', '\t', '#']) && line.contains(':') && !line.contains(":=");
        if header {
            if let Some((name, deps, body)) = current.take() {
                recipes.insert(name, (deps, body));
            }
            let (head, deps) = line.split_once(':').unwrap();
            let name = head.split_whitespace().next().unwrap().to_owned();
            current = Some((name, deps.to_owned(), String::new()));
        } else if let Some((_, _, body)) = current.as_mut()
            && line.starts_with([' ', '\t'])
        {
            body.push_str(line);
            body.push('\n');
        }
    }
    if let Some((name, deps, body)) = current {
        recipes.insert(name, (deps, body));
    }
    let mut run = Vec::new();
    let mut todo = vec![start.to_owned()];
    while let Some(name) = todo.pop() {
        if run.iter().any(|(n, _)| *n == name) {
            continue;
        }
        let (deps, body) = recipes
            .get(&name)
            .unwrap_or_else(|| panic!("no recipe {name}"));
        todo.extend(deps.split_whitespace().map(str::to_owned));
        run.push((name, body.clone()));
    }
    run
}

#[test]
fn no_recipe_ci_runs_reaches_the_corpus() {
    let justfile =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../justfile"))
            .unwrap();
    assert!(
        justfile.contains("\ncorpus path:"),
        "the corpus recipe is gone"
    );

    let run = recipes_run_by(&justfile, "ci");
    assert!(run.iter().any(|(name, _)| name == "rust-check"), "{run:?}");
    for (name, body) in run {
        assert_ne!(name, "corpus");
        assert!(
            !body.contains("corpus"),
            "`just ci` runs the corpus through {name}"
        );
    }
}
