//! Duplicate Songs (the same identity in several copies) through the real
//! app over HTTP: each identity is listed once, the preferred copy is chosen
//! by the fixed rule (an edited copy, then one whose media plays without
//! conversion, then the newest `.txt`), and every other copy is a Library
//! problem naming the preferred one. Media is made by the real ffmpeg at
//! test time.

use std::path::Path;
use std::time::{Duration, SystemTime};

use openstar_protocol::library::{
    FileProblem, LibraryProblem, ProblemReason, ProblemSeverity, ScanStatus, SongList, SongSummary,
};
use openstar_test_harness::{AppFolders, Media, TestApp, placeholder_media};

const ONE_DAY: Duration = Duration::from_secs(24 * 60 * 60);

/// A copy of the Song "Artist - Title" in `folder`, its `.txt` dated
/// `days_ago`, playing `song.mp3` (native) and, with `avi_video`, a separate
/// AVI video the Stage cannot play without conversion.
fn copy_of_the_song(songs: &Path, folder: &str, days_ago: u32, avi_video: Option<&Media>) {
    let folder = songs.join(folder);
    std::fs::create_dir_all(&folder).unwrap();
    placeholder_media(&folder.join("song.mp3")).unwrap();
    let mut headers = "#ARTIST:Artist\n#TITLE:Title\n#BPM:200\n#MP3:song.mp3\n".to_owned();
    if let Some(media) = avi_video {
        let avi = media.tiny_video("clip.avi", 0.5).unwrap();
        std::fs::copy(avi, folder.join("clip.avi")).unwrap();
        headers.push_str("#VIDEO:clip.avi\n");
    }
    let txt = folder.join("song.txt");
    std::fs::write(&txt, format!("{headers}: 0 4 0 La\nE\n")).unwrap();
    let mtime = SystemTime::now() - ONE_DAY * days_ago;
    std::fs::File::options()
        .write(true)
        .open(&txt)
        .unwrap()
        .set_modified(mtime)
        .unwrap();
}

/// The Original a Timing edit keeps beside the `.txt`: the copy has been
/// edited by OpenStar.
fn mark_edited(songs: &Path, folder: &str) {
    let txt = songs.join(folder).join("song.txt");
    std::fs::copy(&txt, songs.join(folder).join("song.txt.orig")).unwrap();
}

async fn listed(app: &TestApp) -> Vec<SongSummary> {
    app.get_json::<SongList>("/api/songs").await.songs
}

async fn problems(app: &TestApp) -> Vec<LibraryProblem> {
    app.get_json("/api/library/problems").await
}

fn hidden_duplicate(path: &str, preferred: &str) -> LibraryProblem {
    LibraryProblem {
        path: path.into(),
        severity: ProblemSeverity::Hidden,
        reason: ProblemReason::File(FileProblem::HiddenDuplicate {
            preferred: preferred.into(),
        }),
    }
}

/// Only the hidden-duplicate problems (a video under conversion adds none,
/// but keeps the assertions about duplicates alone).
async fn duplicates(app: &TestApp) -> Vec<LibraryProblem> {
    problems(app)
        .await
        .into_iter()
        .filter(|p| {
            matches!(
                p.reason,
                ProblemReason::File(FileProblem::HiddenDuplicate { .. })
            )
        })
        .collect()
}

/// The one listed copy of "Artist - Title".
async fn shown_copy(app: &TestApp) -> String {
    let songs = listed(app).await;
    let copies: Vec<&SongSummary> = songs.iter().filter(|s| s.title == "Title").collect();
    assert_eq!(copies.len(), 1, "one entry per identity: {songs:?}");
    copies[0].path.clone()
}

async fn rescan(app: &TestApp) {
    let before: ScanStatus = app.get_json("/api/library/scan").await;
    let response = app
        .http()
        .post(app.url("/api/library/rescan"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let status: ScanStatus = app.get_json("/api/library/scan").await;
        if !status.running && status.finished > before.finished {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the Rescan did not finish: {status:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn copies_of_one_identity_are_listed_once_and_the_others_are_problems() {
    let folders = AppFolders::new();
    let songs = folders.songs_dir();
    copy_of_the_song(songs, "First", 3, None);
    copy_of_the_song(songs, "Second", 2, None);
    copy_of_the_song(songs, "Third", 1, None);
    let app = TestApp::builder().folders(folders).start().await;

    assert_eq!(shown_copy(&app).await, "Third/song.txt");
    assert_eq!(
        problems(&app).await,
        vec![
            hidden_duplicate("First/song.txt", "Third/song.txt"),
            hidden_duplicate("Second/song.txt", "Third/song.txt"),
        ]
    );
}

#[tokio::test]
async fn an_edited_copy_is_preferred_over_native_media_and_a_newer_txt() {
    let media = Media::new();
    let folders = AppFolders::new();
    let songs = folders.songs_dir();
    // Older, and its video needs conversion, but OpenStar has edited it.
    copy_of_the_song(songs, "Edited", 5, Some(&media));
    mark_edited(songs, "Edited");
    copy_of_the_song(songs, "Plain", 1, None);
    let app = TestApp::builder().folders(folders).start().await;

    assert_eq!(shown_copy(&app).await, "Edited/song.txt");
    assert_eq!(
        duplicates(&app).await,
        vec![hidden_duplicate("Plain/song.txt", "Edited/song.txt")]
    );
}

#[tokio::test]
async fn a_copy_whose_media_plays_without_conversion_is_preferred_over_a_newer_txt() {
    let media = Media::new();
    let folders = AppFolders::new();
    let songs = folders.songs_dir();
    copy_of_the_song(songs, "Native", 5, None);
    copy_of_the_song(songs, "Converted", 1, Some(&media));
    let app = TestApp::builder().folders(folders).start().await;

    assert_eq!(shown_copy(&app).await, "Native/song.txt");
    assert_eq!(
        duplicates(&app).await,
        vec![hidden_duplicate("Converted/song.txt", "Native/song.txt")]
    );
}

#[tokio::test]
async fn between_two_edited_copies_with_native_media_the_newest_txt_is_preferred() {
    let folders = AppFolders::new();
    let songs = folders.songs_dir();
    copy_of_the_song(songs, "Older", 4, None);
    copy_of_the_song(songs, "Newer", 2, None);
    mark_edited(songs, "Older");
    mark_edited(songs, "Newer");
    let app = TestApp::builder().folders(folders).start().await;

    assert_eq!(shown_copy(&app).await, "Newer/song.txt");
    assert_eq!(
        problems(&app).await,
        vec![hidden_duplicate("Older/song.txt", "Newer/song.txt")]
    );
}

#[tokio::test]
async fn when_the_preferred_copy_goes_the_next_scan_shows_another_copy() {
    let folders = AppFolders::new();
    let songs = folders.songs_dir();
    copy_of_the_song(songs, "Kept", 3, None);
    copy_of_the_song(songs, "Preferred", 1, None);
    let app = TestApp::builder().folders(folders).start().await;
    assert_eq!(shown_copy(&app).await, "Preferred/song.txt");
    assert_eq!(
        problems(&app).await,
        vec![hidden_duplicate("Kept/song.txt", "Preferred/song.txt")]
    );

    std::fs::remove_dir_all(app.songs_dir().join("Preferred")).unwrap();
    rescan(&app).await;

    assert_eq!(shown_copy(&app).await, "Kept/song.txt");
    assert_eq!(problems(&app).await, vec![]);
}

#[tokio::test]
async fn an_edit_kept_beside_a_copy_changes_the_preferred_copy_at_the_next_scan() {
    let folders = AppFolders::new();
    let songs = folders.songs_dir();
    copy_of_the_song(songs, "Older", 3, None);
    copy_of_the_song(songs, "Newer", 1, None);
    let app = TestApp::builder().folders(folders).start().await;
    assert_eq!(shown_copy(&app).await, "Newer/song.txt");

    // An Original appears beside the unchanged older `.txt`.
    mark_edited(app.songs_dir(), "Older");
    rescan(&app).await;

    assert_eq!(shown_copy(&app).await, "Older/song.txt");
    assert_eq!(
        problems(&app).await,
        vec![hidden_duplicate("Newer/song.txt", "Older/song.txt")]
    );
}
