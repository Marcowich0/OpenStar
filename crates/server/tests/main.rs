//! Every integration test of this crate, in one test binary.
//!
//! Each file in `tests/` would otherwise be a binary of its own, each linking
//! the whole crate and its dependencies: slow to link and gigabytes on disk.
//! So `autotests = false` in `Cargo.toml`, and each file is a module here.
//! A new test file needs its `mod` line below, or it never runs;
//! `every_test_file_is_a_module` fails until it has one. A file that must
//! run in a process of its own is a `[[test]]` of its own in `Cargo.toml`.

mod auto_fit_phone;
mod av_offset;
mod av_sync;
mod binary;
mod bridge_detecting;
mod bridge_files;
mod bridge_levels;
mod bridge_profile;
mod bridge_readings;
mod bridge_update;
mod calibration;
mod calibration_local_mics;
mod corpus;
mod db_snapshots;
mod deletions;
mod fixture_library;
mod forget_bridge;
mod guard;
mod guests;
mod high_scores;
mod jobs;
mod leaving;
mod library_conversion;
mod library_duplicates;
mod library_identity;
mod library_loudness;
mod library_media;
mod library_publish;
mod library_scan;
mod library_search;
mod line_score;
mod line_up;
mod line_up_editing;
mod live_state;
mod local_mics;
mod local_mics_line_up;
mod mic_bridge;
mod mic_settings;
mod mic_warnings;
mod not_calibrated;
mod note_fingerprint;
mod party;
mod phone_mic_diagnostics;
mod phone_reconnect;
mod phones;
mod pin_wait;
mod pitch_track;
mod play;
mod profile_stats;
mod profiles;
mod queue;
mod read_only_library;
mod relay;
mod results;
mod routes;
mod score_identity_move;
mod scores;
mod song_delete;
mod song_drops;
mod song_playing_now;
mod song_progress;
mod song_restore;
mod stage_options;
mod stage_outputs;
mod stage_trust;
mod startup;
mod timing_save;
mod txt_body;
mod txt_encoding;
mod txt_fixtures;
mod txt_headers;
mod txt_writer;
mod unlock;
mod usdb_client;
mod usdb_downloads;
mod usdb_mirror;
mod usdb_pages;
mod usdb_search;
mod usdb_song_txt;
mod usdb_videos;
mod walking_skeleton;
mod ytdlp_update;

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
