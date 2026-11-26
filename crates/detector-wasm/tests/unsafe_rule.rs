//! The workspace's one exemption from `unsafe_code = "forbid"` stays as narrow
//! as the root `Cargo.toml` says: `detector-wasm` is the only crate with lints
//! of its own, and the only `unsafe` in it is `#[unsafe(no_mangle)]` on its
//! exports, each with its own `allow`.

use std::path::{Path, PathBuf};

fn workspace() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn crate_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(workspace().join("crates"))
        .expect("crates/")
        .map(|e| e.expect("entry").path())
        .filter(|p| p.join("Cargo.toml").is_file())
        .collect();
    dirs.sort();
    dirs
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read dir") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn the_workspace_forbids_unsafe_code() {
    let root = std::fs::read_to_string(workspace().join("Cargo.toml")).expect("Cargo.toml");
    assert!(
        root.contains("[workspace.lints.rust]\nunsafe_code = \"forbid\""),
        "the root Cargo.toml must forbid unsafe code"
    );
}

#[test]
fn every_other_crate_uses_the_workspace_lints() {
    for dir in crate_dirs() {
        let name = dir
            .file_name()
            .expect("name")
            .to_string_lossy()
            .into_owned();
        let manifest = std::fs::read_to_string(dir.join("Cargo.toml")).expect("Cargo.toml");
        if name == "detector-wasm" {
            assert!(manifest.contains("[lints.rust]\nunsafe_code = \"deny\""));
            continue;
        }
        assert!(
            manifest.contains("[lints]\nworkspace = true"),
            "{name}: must inherit the workspace lints"
        );
        assert!(
            !manifest.contains("[lints.") && !manifest.contains("unsafe_code"),
            "{name}: must not set lints of its own"
        );
    }
}

#[test]
fn the_only_unsafe_in_detector_wasm_is_no_mangle_on_its_exports() {
    let mut files = Vec::new();
    rust_files(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );
    let mut exports = 0;
    for file in files {
        let text = std::fs::read_to_string(&file).expect("source");
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            let code = line.split("//").next().unwrap_or_default();
            if !code.contains("unsafe") {
                continue;
            }
            let at = format!("{}:{}", file.display(), i + 1);
            if code.contains("allow(unsafe_code") {
                assert!(
                    lines
                        .get(i + 1)
                        .is_some_and(|l| l.trim() == "#[unsafe(no_mangle)]"),
                    "{at}: an allow(unsafe_code) must sit right above #[unsafe(no_mangle)]"
                );
                continue;
            }
            assert_eq!(
                code.trim(),
                "#[unsafe(no_mangle)]",
                "{at}: unsafe beyond no_mangle"
            );
            assert!(
                lines
                    .get(i + 1)
                    .is_some_and(|l| l.trim_start().starts_with("pub extern \"C\" fn ")),
                "{at}: no_mangle must mark a `pub extern \"C\" fn` export"
            );
            exports += 1;
        }
    }
    assert!(exports > 0, "detector-wasm has no exports");
}

/// No JavaScript glue generator on the Rust side either: the crate depends on
/// the detector and the capture clock alone, which depend on nothing.
#[test]
fn detector_wasm_has_no_glue_generator() {
    let manifest =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
            .expect("Cargo.toml");
    let dependencies = manifest
        .split("[dependencies]")
        .nth(1)
        .and_then(|rest| rest.split("\n[").next())
        .expect("[dependencies]");
    let names: Vec<&str> = dependencies
        .lines()
        .filter_map(|l| l.split('=').next().map(str::trim))
        .filter(|n| !n.is_empty() && !n.starts_with('#'))
        .collect();
    assert_eq!(
        names,
        [
            "openstar-capture-clock.workspace",
            "openstar-detector.workspace"
        ]
    );

    // …and they have no dependencies at all, so the WASM module's whole
    // dependency tree is these three crates.
    for dependency in ["detector", "capture-clock"] {
        let manifest =
            std::fs::read_to_string(workspace().join(format!("crates/{dependency}/Cargo.toml")))
                .expect("Cargo.toml");
        assert!(
            !manifest.contains("\n[dependencies]"),
            "{dependency} must stay free of dependencies"
        );
    }
}
