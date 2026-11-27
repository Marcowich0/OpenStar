//! Score records follow a Song's identity key when OpenStar's own edit
//! changes it (#189), through the real app over HTTP.
//!
//! No v1 Timing operation changes artist, title or duet, so the own edit
//! applied here is Restore Original with an Original (planted by the test)
//! whose title differs from the `.txt`: the same write-to-index path every
//! Library write of OpenStar takes. What is stored is read back through
//! `openstar::scores`' read functions over the app's own database file.

use std::time::Duration;

use openstar::scores::rounds;
use openstar_protocol::library::{ScanStatus, SongDetail, SongId, SongIdentity, SongList};
use openstar_protocol::party::{PartyId, RequestId};
use openstar_protocol::profile::Difficulty;
use openstar_protocol::scoring::{
    BeatRange, BeatValue, MicKind, PlayerScore, RoundEnd, RoundMode, RoundOutcome, ScorePlayer,
};
use openstar_test_harness::TestApp;
use reqwest::StatusCode;

/// A solo Song of two Notes: Beats 0 to 7.
const SOLO: &str = ": 0 4 0 La\n: 4 4 2 lo\nE\n";

fn txt(title: &str) -> String {
    format!("#ARTIST:Placeholder Artist\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n{SOLO}")
}

/// A Song in `folder` titled `title`, with an Original titled `original`
/// beside it when one is given.
fn write_song(app: &TestApp, folder: &str, title: &str, original: Option<&str>) {
    let folder = app.songs_dir().join(folder);
    std::fs::create_dir_all(&folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(folder.join("song.txt"), txt(title)).unwrap();
    if let Some(original) = original {
        std::fs::write(folder.join("song.txt.orig"), txt(original)).unwrap();
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
        assert!(tokio::time::Instant::now() < deadline, "the Rescan hung");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn detail(app: &TestApp, id: SongId) -> SongDetail {
    app.get_json(&format!("/api/songs/{}", id.0)).await
}

/// The id of the Song titled `title`.
async fn song_id(app: &TestApp, title: &str) -> SongId {
    app.get_json::<SongList>("/api/songs")
        .await
        .songs
        .iter()
        .find(|s| s.title == title)
        .unwrap_or_else(|| panic!("{title} is not in the Song list"))
        .id
}

fn next_request() -> RequestId {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    RequestId(NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

/// Stores one played round of `song` with one Guest record.
async fn store_round(app: &TestApp, song: &SongDetail) {
    let outcome = RoundOutcome {
        song_id: song.id,
        note_fingerprint: song.note_fingerprint.clone(),
        request_id: next_request(),
        party_id: PartyId("party-1".into()),
        mode: RoundMode::Normal,
        started_at_ms: 1_700_000_000_000,
        ended: RoundEnd::Played,
        scores: vec![PlayerScore {
            player: ScorePlayer::Guest {
                name: "Zoë".into()
            },
            voice: 0,
            difficulty: Difficulty::Hard,
            total: 10,
            notes: 5,
            golden: 0,
            line_bonus: 5,
            mic_kind: MicKind::Phone,
            unfinished: false,
            mic_lost: false,
            beat_range: BeatRange {
                first_beat: 0,
                last_beat: 7,
            },
            beat_values: vec![BeatValue::NoVoice; 8],
        }],
    };
    let response = app
        .http()
        .post(app.url("/api/test/rounds"))
        .json(&outcome)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

fn open_db(app: &TestApp) -> rusqlite::Connection {
    let conn =
        rusqlite::Connection::open(app.appdata_dir().join(openstar::db::DATABASE_FILE)).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .unwrap();
    conn
}

/// The Song identity of every stored round and every Score record.
fn stored_identities(app: &TestApp) -> Vec<SongIdentity> {
    rounds(&open_db(app))
        .unwrap()
        .iter()
        .flat_map(|round| {
            std::iter::once(round.song.clone()).chain(round.records.iter().map(|r| r.song.clone()))
        })
        .collect()
}

async fn restore(app: &TestApp, id: SongId) -> StatusCode {
    let cookie = app.unlock().await;
    app.http()
        .post(app.url(&format!("/api/songs/{}/restore-original", id.0)))
        .header("cookie", cookie)
        .send()
        .await
        .unwrap()
        .status()
}

fn artist_title(title: &str) -> SongIdentity {
    SongIdentity::ArtistTitle {
        artist: "placeholder artist".into(),
        title: title.into(),
        duet: false,
    }
}

#[tokio::test]
async fn score_records_follow_an_own_edit_that_changes_the_identity_key() {
    let app = TestApp::builder().test_routes().start().await;
    write_song(&app, "Song", "Old Title", Some("New Title"));
    write_song(&app, "Other", "Other Title", None);
    rescan(&app).await;
    let id = song_id(&app, "Old Title").await;
    let song = detail(&app, id).await;
    assert_eq!(song.identity, artist_title("old title"));
    store_round(&app, &song).await;
    store_round(&app, &song).await;
    store_round(
        &app,
        &detail(&app, song_id(&app, "Other Title").await).await,
    )
    .await;

    assert_eq!(restore(&app, id).await, StatusCode::OK);

    let song = detail(&app, id).await;
    assert_eq!(song.song.headers.title, "New Title");
    assert_eq!(song.identity, artist_title("new title"));
    let new = artist_title("new title");
    let other = artist_title("other title");
    assert_eq!(
        stored_identities(&app),
        [
            new.clone(),
            new.clone(),
            new.clone(),
            new,
            other.clone(),
            other
        ],
        "both rounds of the old key and their records moved; the other Song's stayed"
    );
}

#[tokio::test]
async fn a_failed_move_leaves_the_index_and_the_records_as_they_were() {
    let app = TestApp::builder().test_routes().start().await;
    write_song(&app, "Song", "Old Title", Some("New Title"));
    rescan(&app).await;
    let id = song_id(&app, "Old Title").await;
    store_round(&app, &detail(&app, id).await).await;
    open_db(&app)
        .execute_batch(
            "CREATE TRIGGER refuse_move BEFORE UPDATE ON score_records
             BEGIN SELECT RAISE(ABORT, 'refused by the test'); END;",
        )
        .unwrap();

    assert_eq!(restore(&app, id).await, StatusCode::INTERNAL_SERVER_ERROR);

    let song = detail(&app, id).await;
    assert_eq!(
        song.song.headers.title, "Old Title",
        "the index update was not applied"
    );
    assert_eq!(song.identity, artist_title("old title"));
    assert_eq!(
        stored_identities(&app),
        [artist_title("old title"), artist_title("old title")]
    );
}

#[tokio::test]
async fn a_song_with_a_usdb_id_keeps_its_identity_and_its_records() {
    let app = TestApp::builder().test_routes().start().await;
    write_song(&app, "Song", "Old Title", Some("New Title"));
    std::fs::write(
        app.songs_dir().join("Song/metadata.json"),
        br#"{"apiId": 4711}"#,
    )
    .unwrap();
    rescan(&app).await;
    let id = song_id(&app, "Old Title").await;
    store_round(&app, &detail(&app, id).await).await;

    assert_eq!(restore(&app, id).await, StatusCode::OK);

    let usdb = SongIdentity::Usdb { usdb_id: 4711 };
    let song = detail(&app, id).await;
    assert_eq!(song.song.headers.title, "New Title");
    assert_eq!(song.identity, usdb);
    assert_eq!(stored_identities(&app), [usdb.clone(), usdb]);
}

#[tokio::test]
async fn a_song_renamed_outside_openstar_is_not_matched() {
    let app = TestApp::builder().test_routes().start().await;
    write_song(&app, "Song", "Old Title", None);
    rescan(&app).await;
    let id = song_id(&app, "Old Title").await;
    store_round(&app, &detail(&app, id).await).await;

    // Another program renames the Song; the next Rescan reads it.
    std::fs::write(app.songs_dir().join("Song/song.txt"), txt("New Title")).unwrap();
    rescan(&app).await;

    assert_eq!(detail(&app, id).await.identity, artist_title("new title"));
    assert_eq!(
        stored_identities(&app),
        [artist_title("old title"), artist_title("old title")],
        "the records stay with the old key"
    );
}

#[tokio::test]
async fn records_stay_with_a_copy_that_keeps_the_old_key() {
    let app = TestApp::builder().test_routes().start().await;
    write_song(&app, "Song", "Old Title", Some("New Title"));
    rescan(&app).await;
    let id = song_id(&app, "Old Title").await;
    store_round(&app, &detail(&app, id).await).await;
    // A duplicate of the same Song, which the edit leaves alone.
    write_song(&app, "Copy", "Old Title", None);
    rescan(&app).await;

    assert_eq!(restore(&app, id).await, StatusCode::OK);

    assert_eq!(detail(&app, id).await.identity, artist_title("new title"));
    assert_eq!(
        stored_identities(&app),
        [artist_title("old title"), artist_title("old title")],
        "the copy still has the old key, so its records are not taken from it"
    );
}
