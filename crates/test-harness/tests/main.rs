//! Every integration test of this crate, in one test binary.
//!
//! Each file in `tests/` would otherwise be a binary of its own, each linking
//! the whole crate and its dependencies: slow to link and gigabytes on disk.
//! So `autotests = false` in `Cargo.toml`, and each file is a module here.
//! A new test file needs its `mod` line below, or it never runs;
//! `every_test_file_is_a_module` fails until it has one. A file that must
//! run in a process of its own is a `[[test]]` of its own in `Cargo.toml`.

mod app;
mod bridge_launcher;
mod fake_mic;
mod fake_usdb;
mod fixture_library;
mod media;
mod standalone;
mod support;
mod ytdlp_stub;

#[test]
fn every_test_file_is_a_module() {
    let tests = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let main = include_str!("main.rs");
    let cargo = include_str!("../Cargo.toml");
    let mut missing: Vec<String> = std::fs::read_dir(&tests)
        .expect("tests/ is readable")
        .map(|entry| entry.expect("tests/ entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
        .filter_map(|path| Some(path.file_stem()?.to_str()?.to_owned()))
        .filter(|stem| stem != "main")
        .filter(|stem| !main.contains(&format!("\nmod {stem};\n")))
        .filter(|stem| !cargo.contains(&format!("path = \"tests/{stem}.rs\"")))
        .collect();
    missing.sort();
    assert!(
        missing.is_empty(),
        "add `mod <name>;` to tests/main.rs for each of {missing:?}"
    );
}
