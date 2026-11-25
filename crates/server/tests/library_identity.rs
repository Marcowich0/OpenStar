//! Song identity through the real app over HTTP: the USDB id from a
//! `metadata.json` beside the `.txt`, otherwise the normalised artist and
//! title plus the duet flag. Media files are created empty.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use openstar_protocol::library::{
    FileProblem, LibraryProblem, ProblemReason, ProblemSeverity, ScanStatus, SongDetail,
    SongIdentity, SongSummary,
};
use openstar_test_harness::{AppFolders, TestApp};

/// Writes a playable Song (`song.txt` + empty `song.mp3`) into `folder`.
fn write_song(folder: &Path, artist: &str, title: &str, duet: bool) {
    std::fs::create_dir_all(folder).unwrap();
    std::fs::write(folder.join("song.mp3"), b"").unwrap();
    let body = if duet {
        "P1\n: 0 4 0 La\nP2\n: 4 4 2 lo\nE\n"
    } else {
        ": 0 4 0 La\nE\n"
    };
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:{artist}\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n{body}"),
    )
    .unwrap();
}

fn artist_title(artist: &str, title: &str, duet: bool) -> SongIdentity {
    SongIdentity::ArtistTitle {
        artist: artist.into(),
        title: title.into(),
        duet,
    }
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
            "the Rescan did not finish within 30 s: {status:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The identity of each listed Song, by path.
async fn identities(app: &TestApp) -> BTreeMap<String, SongIdentity> {
    let songs: Vec<SongSummary> = app.get_json("/api/songs").await;
    songs.into_iter().map(|s| (s.path, s.identity)).collect()
}

async fn present(app: &TestApp, identity: &SongIdentity) -> bool {
    identities(app).await.values().any(|i| i == identity)
}

async fn detail(app: &TestApp, path: &str) -> SongDetail {
    let songs: Vec<SongSummary> = app.get_json("/api/songs").await;
    let id = songs
        .iter()
        .find(|s| s.path == path)
        .unwrap_or_else(|| panic!("{path} is not in the Song list"))
        .id;
    app.get_json(&format!("/api/songs/{}", id.0)).await
}

#[tokio::test]
async fn the_usdb_id_from_metadata_json_is_the_identity_in_list_and_detail() {
    let folders = AppFolders::new();
    let folder = folders.songs_dir().join("Some Artist - Some Song");
    write_song(&folder, "Some Artist", "Some Song", false);
    std::fs::write(
        folder.join("metadata.json"),
        br#"{"apiId": 4711, "other": "kept"}"#,
    )
    .unwrap();
    write_song(
        &folders.songs_dir().join("Plain"),
        "  Ｐlain\tBand ",
        "STRASSE  Song",
        true,
    );
    let app = TestApp::builder().folders(folders).start().await;

    let usdb = SongIdentity::Usdb { usdb_id: 4711 };
    assert_eq!(
        identities(&app).await,
        BTreeMap::from([
            ("Some Artist - Some Song/song.txt".to_owned(), usdb.clone()),
            (
                "Plain/song.txt".to_owned(),
                artist_title("plain band", "strasse song", true)
            ),
        ])
    );
    let song = detail(&app, "Some Artist - Some Song/song.txt").await;
    assert_eq!(song.identity, usdb);
    assert!(song.warnings.is_empty());
}

#[tokio::test]
async fn an_unreadable_metadata_json_is_a_warning_and_falls_back_to_artist_and_title() {
    let folders = AppFolders::new();
    let folder = folders.songs_dir().join("Broken");
    write_song(&folder, "Artist", "Title", false);
    std::fs::write(folder.join("metadata.json"), b"{ not json").unwrap();
    let app = TestApp::builder().folders(folders).start().await;

    let problems: Vec<LibraryProblem> = app.get_json("/api/library/problems").await;
    assert_eq!(
        problems,
        vec![LibraryProblem {
            path: "Broken/song.txt".into(),
            severity: ProblemSeverity::Warning,
            reason: ProblemReason::File(FileProblem::UnreadableMetadata),
        }]
    );
    let song = detail(&app, "Broken/song.txt").await;
    assert_eq!(song.identity, artist_title("artist", "title", false));
    assert_eq!(
        song.warnings,
        vec![ProblemReason::File(FileProblem::UnreadableMetadata)]
    );
}

#[tokio::test]
async fn a_metadata_json_is_read_again_at_every_scan() {
    let folders = AppFolders::new();
    let folder = folders.songs_dir().join("Later");
    write_song(&folder, "Artist", "Title", false);
    let app = TestApp::builder().folders(folders).start().await;
    assert!(present(&app, &artist_title("artist", "title", false)).await);

    // The .txt is unchanged; only its metadata.json is new.
    std::fs::write(
        app.songs_dir().join("Later/metadata.json"),
        br#"{"apiId": "99"}"#,
    )
    .unwrap();
    rescan(&app).await;
    assert_eq!(
        identities(&app).await["Later/song.txt"],
        SongIdentity::Usdb { usdb_id: 99 }
    );
}

#[tokio::test]
async fn a_renamed_folder_keeps_its_identity_and_a_returned_song_is_present_again() {
    let folders = AppFolders::new();
    write_song(&folders.songs_dir().join("Solo"), "Artist", "Title", false);
    let with_id = folders.songs_dir().join("With Id");
    write_song(&with_id, "Artist", "Title", false);
    std::fs::write(with_id.join("metadata.json"), br#"{"apiId": 7}"#).unwrap();
    let app = TestApp::builder().folders(folders).start().await;
    let songs = app.songs_dir().to_owned();
    let solo = artist_title("artist", "title", false);
    let usdb = SongIdentity::Usdb { usdb_id: 7 };
    assert_eq!(identities(&app).await["Solo/song.txt"], solo);
    assert_eq!(identities(&app).await["With Id/song.txt"], usdb);

    // Renamed and moved deeper: same identities under the new paths.
    std::fs::create_dir(songs.join("Moved")).unwrap();
    std::fs::rename(songs.join("Solo"), songs.join("Moved/Solo Renamed")).unwrap();
    std::fs::rename(songs.join("With Id"), songs.join("Elsewhere")).unwrap();
    rescan(&app).await;
    assert_eq!(
        identities(&app).await,
        BTreeMap::from([
            ("Moved/Solo Renamed/song.txt".to_owned(), solo.clone()),
            ("Elsewhere/song.txt".to_owned(), usdb.clone()),
        ])
    );

    // Removed, then returned: present, absent, present.
    assert!(present(&app, &usdb).await);
    let outside = app.appdata_dir().join("kept aside");
    std::fs::rename(songs.join("Elsewhere"), &outside).unwrap();
    rescan(&app).await;
    assert!(!present(&app, &usdb).await);
    assert!(present(&app, &solo).await);
    std::fs::rename(&outside, songs.join("Back Again")).unwrap();
    rescan(&app).await;
    assert!(present(&app, &usdb).await);
    assert_eq!(identities(&app).await["Back Again/song.txt"], usdb);
}

/// Every file under `dir` with its bytes and mtime.
fn tree(dir: &Path) -> BTreeMap<String, (Vec<u8>, std::time::SystemTime)> {
    let mut files = BTreeMap::new();
    let mut folders = vec![dir.to_owned()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                folders.push(entry.path());
            } else {
                let metadata = entry.metadata().unwrap();
                files.insert(
                    entry
                        .path()
                        .strip_prefix(dir)
                        .unwrap()
                        .display()
                        .to_string(),
                    (
                        std::fs::read(entry.path()).unwrap(),
                        metadata.modified().unwrap(),
                    ),
                );
            }
        }
    }
    files
}

#[tokio::test]
async fn identifying_songs_writes_nothing_into_the_library() {
    let folders = AppFolders::new();
    write_song(&folders.songs_dir().join("A"), "Artist", "Title", true);
    let with_id = folders.songs_dir().join("B");
    write_song(&with_id, "Other", "Song", false);
    std::fs::write(with_id.join("metadata.json"), br#"{"apiId": 3}"#).unwrap();
    let broken = folders.songs_dir().join("C");
    write_song(&broken, "Third", "Song", false);
    std::fs::write(broken.join("metadata.json"), b"[]").unwrap();
    let before = tree(folders.songs_dir());

    let app = TestApp::builder().folders(folders).start().await;
    rescan(&app).await;
    assert_eq!(identities(&app).await.len(), 3);
    assert_eq!(tree(app.songs_dir()), before);
}
