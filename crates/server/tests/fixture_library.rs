//! The fixture Library (`fixtures/library/`), with its audio generated from
//! its Notes, scanned by the real app: the Library `just e2e` serves.

use openstar_protocol::library::{
    LibraryProblem, ProblemReason, ProblemSeverity, SongDetail, SongList, SongSummary, SongVideo,
};
use openstar_protocol::song::TxtRejection;
use openstar_test_harness::fixture_library::{
    DUET, REJECTED, SEPARATE_VIDEO, SINE_MELODY, STEADY_TONE,
};
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
    let mut expected = vec![STEADY_TONE, SINE_MELODY, DUET, SEPARATE_VIDEO];
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

#[tokio::test]
async fn the_separate_video_song_plays_its_audio_with_a_native_video_following_at_videogap() {
    let app = start().await;
    let songs: Vec<SongSummary> = app.get_json::<SongList>("/api/songs").await.songs;
    let summary = songs.iter().find(|s| s.path == SEPARATE_VIDEO).unwrap();
    assert!(summary.has_video);
    let detail: SongDetail = app.get_json(&format!("/api/songs/{}", summary.id.0)).await;
    assert!(detail.media.audio.native);
    let Some(SongVideo::File { file, gap_seconds }) = detail.media.video else {
        panic!("a separate video file: {:?}", detail.media.video);
    };
    assert!(file.native, "the generated VP8 WebM plays as it is");
    assert!((gap_seconds - -1.5).abs() < 1e-9);
    let video = app.http().get(app.url(&file.url)).send().await.unwrap();
    assert_eq!(video.status(), 200);
}
