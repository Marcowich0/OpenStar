//! The fixture Library (`fixtures/library/`), with its audio generated from
//! its Notes, scanned by the real app: the Library `just e2e` serves.

use openstar_protocol::library::{
    LibraryProblem, ProblemReason, ProblemSeverity, SongDetail, SongList, SongSummary,
};
use openstar_protocol::song::TxtRejection;
use openstar_test_harness::fixture_library::{DUET, REJECTED, SINE_MELODY, STEADY_TONE};
use openstar_test_harness::{AppFolders, TestApp};

async fn start() -> TestApp {
    TestApp::builder()
        .folders(AppFolders::with_fixture_library())
        .start()
        .await
}

#[tokio::test]
async fn every_song_but_the_rejected_file_is_playable() {
    let app = start().await;
    let songs: Vec<SongSummary> = app.get_json::<SongList>("/api/songs").await.songs;
    let mut paths: Vec<&str> = songs.iter().map(|s| s.path.as_str()).collect();
    paths.sort_unstable();
    let mut expected = vec![STEADY_TONE, SINE_MELODY, DUET];
    expected.sort_unstable();
    assert_eq!(paths, expected);
    assert_eq!(
        songs.iter().find(|s| s.path == DUET).map(|s| s.duet),
        Some(true)
    );

    for summary in &songs {
        let detail: SongDetail = app.get_json(&format!("/api/songs/{}", summary.id.0)).await;
        assert_eq!(detail.warnings, [], "{} has warnings", summary.path);
    }
}

#[tokio::test]
async fn the_rejected_file_is_a_library_problem_with_its_reason() {
    let app = start().await;
    let problems: Vec<LibraryProblem> = app.get_json("/api/library/problems").await;
    assert_eq!(
        problems,
        [LibraryProblem {
            path: REJECTED.into(),
            severity: ProblemSeverity::Rejection,
            reason: ProblemReason::Rejection(TxtRejection::UnsupportedVersion { line: 1 }),
        }]
    );
}
