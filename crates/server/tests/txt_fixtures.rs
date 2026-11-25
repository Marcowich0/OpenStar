//! Every `.txt` under `fixtures/txt/` parsed, with an `insta` snapshot of the
//! parsed form plus its warnings, or of its rejection. The folder holding a
//! fixture is passed as its folder name, so the folder-name rule can be
//! exercised by a fixture folder named `Artist - Title`.

use std::path::{Path, PathBuf};

use openstar::txt::parse;

fn fixtures_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/txt")
}

fn txt_files(dir: &Path, found: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("fixture folder is readable") {
        let path = entry.expect("fixture entry is readable").path();
        if path.is_dir() {
            txt_files(&path, found);
        } else if path.extension().is_some_and(|e| e == "txt") {
            found.push(path);
        }
    }
}

#[test]
fn txt_fixtures_parse_to_their_snapshots() {
    let root = fixtures_root();
    let mut files = Vec::new();
    txt_files(&root, &mut files);
    files.sort();
    assert!(!files.is_empty(), "no fixtures under {}", root.display());

    for path in files {
        let relative = path
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let folder_name = path
            .parent()
            .and_then(Path::file_name)
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let bytes = std::fs::read(&path).unwrap();
        let parsed = parse(&bytes, &folder_name);

        if let Ok(file) = &parsed {
            let rebuilt: Vec<u8> = file
                .lines
                .iter()
                .flat_map(|l| [l.bytes.as_slice(), l.ending.as_bytes()].concat())
                .collect();
            assert_eq!(rebuilt, bytes, "{relative}: the line model is not lossless");
        }

        insta::with_settings!({
            snapshot_suffix => relative.replace(['/', ' '], "_"),
            description => relative.as_str(),
            omit_expression => true,
            prepend_module_to_snapshot => false,
        }, {
            insta::assert_debug_snapshot!("txt", parsed);
        });
    }
}
