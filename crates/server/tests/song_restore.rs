//! Restoring a Song from the trash, and the 30-day purge (#191), through the
//! real app over HTTP and WebSocket, with every effect checked on disk: the
//! trash lists each trashed Song folder, a restore moves it back to its
//! original path and straight into the index (its Score records show again),
//! a restore onto an existing folder is refused and writes nothing, and a
//! trashed folder and its ledger row go 30 days after the delete, by the
//! purge that runs at start.

use std::path::Path;
use std::time::{Duration, SystemTime};

use openstar::clock::ManualClock;

use openstar_protocol::library::{SongDetail, SongId, SongList, TrashId, TrashList, TrashedSong};
use openstar_protocol::party::{PartyId, RequestId};
use openstar_protocol::profile::{Avatar, AvatarKey, Difficulty, NewProfile, PaletteKey, Profile};
use openstar_protocol::scoring::{
    BeatRange, BeatValue, MicKind, PlayerScore, RoundEnd, RoundMode, RoundOutcome, ScorePlayer,
};
use openstar_protocol::{ChangeTopic, ServerMessage, UserMessage};
use openstar_test_harness::{TestApp, TestAppBuilder};
use reqwest::StatusCode;

/// 30 days.
const KEPT_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);

fn write_song(folder: &Path, title: &str) {
    std::fs::create_dir_all(folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:Placeholder\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n"),
    )
    .unwrap();
}

/// An app whose Library holds `Older/Solo` (with an `extras/notes.md`) and
/// `Encore`.
async fn app_with(builder: TestAppBuilder) -> TestApp {
    let mut app = builder.start().await;
    let songs = app.songs_dir().to_owned();
    write_song(&songs.join("Older/Solo"), "Solo");
    std::fs::create_dir_all(songs.join("Older/Solo/extras")).unwrap();
    std::fs::write(songs.join("Older/Solo/extras/notes.md"), b"kept").unwrap();
    write_song(&songs.join("Encore"), "Encore");
    app.restart().await;
    app
}

async fn detail(app: &TestApp, title: &str) -> SongDetail {
    let id = song_id(app, title).await;
    app.get_json(&format!("/api/songs/{}", id.0)).await
}

async fn song_id(app: &TestApp, title: &str) -> SongId {
    let songs = app.get_json::<SongList>("/api/songs").await.songs;
    songs.into_iter().find(|s| s.title == title).unwrap().id
}

async fn titles(app: &TestApp) -> Vec<String> {
    let songs = app.get_json::<SongList>("/api/songs").await.songs;
    let mut titles: Vec<String> = songs.into_iter().map(|s| s.title).collect();
    titles.sort();
    titles
}

/// Every file below `dir`, relative, with `/`, sorted.
fn files(dir: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let relative = path.strip_prefix(root).unwrap();
                out.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = Vec::new();
    if dir.exists() {
        walk(dir, dir, &mut out);
    }
    out.sort();
    out
}

/// Every entry directly in `/appdata/trash`.
fn trash_entries(app: &TestApp) -> Vec<String> {
    let trash = app.appdata_dir().join("trash");
    let mut names: Vec<String> = match std::fs::read_dir(trash) {
        Ok(entries) => entries
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

/// The trash ledger's original paths, by id.
fn ledger(app: &TestApp) -> Vec<String> {
    let db =
        rusqlite::Connection::open(app.appdata_dir().join(openstar::db::DATABASE_FILE)).unwrap();
    let mut statement = db
        .prepare("SELECT original_path FROM trash ORDER BY id")
        .unwrap();
    statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn millis(time: SystemTime) -> i64 {
    i64::try_from(
        time.duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

async fn delete(app: &TestApp, cookie: &str, id: SongId) {
    let response = app
        .http()
        .delete(app.url(&format!("/api/songs/{}", id.0)))
        .header("cookie", cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

async fn trash(app: &TestApp) -> Vec<TrashedSong> {
    app.get_json::<TrashList>("/api/library/trash").await.songs
}

async fn restore(app: &TestApp, cookie: Option<&str>, id: TrashId) -> (StatusCode, String) {
    let mut request = app
        .http()
        .post(app.url(&format!("/api/library/trash/{}/restore", id.0)));
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let response = request.send().await.unwrap();
    (response.status(), response.text().await.unwrap())
}

fn refusal(body: &str) -> UserMessage {
    serde_json::from_str(body).unwrap()
}

async fn create_profile(app: &TestApp) -> Profile {
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(&NewProfile {
            name: "Singer".into(),
            avatar: Avatar::BuiltIn {
                key: AvatarKey::Star,
            },
            favourite_colour: PaletteKey::ALL[0],
        })
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    response.json().await.unwrap()
}

/// Stores a Finished Hard round of `total` for `profile` on `song`.
async fn store_round(app: &TestApp, song: &SongDetail, profile: &Profile, total: u32) {
    let outcome = RoundOutcome {
        song_id: song.id,
        note_fingerprint: song.note_fingerprint.clone(),
        request_id: RequestId(1),
        party_id: PartyId("party-1".into()),
        mode: RoundMode::Normal,
        started_at_ms: 1_700_000_000_000,
        ended: RoundEnd::Played,
        scores: vec![PlayerScore {
            player: ScorePlayer::Profile {
                profile_id: profile.id,
            },
            voice: 0,
            difficulty: Difficulty::Hard,
            total,
            notes: total / 2,
            golden: 0,
            line_bonus: total - total / 2,
            mic_kind: MicKind::Phone,
            unfinished: false,
            mic_lost: false,
            beat_range: BeatRange {
                first_beat: 0,
                last_beat: 3,
            },
            beat_values: vec![BeatValue::Pitch { pitch: 60.0 }; 4],
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

async fn top_score(app: &TestApp, title: &str) -> Option<u32> {
    let songs = app.get_json::<SongList>("/api/songs").await.songs;
    let song = songs.into_iter().find(|s| s.title == title)?;
    song.top_high_score.map(|top| top.total)
}

#[tokio::test]
async fn the_trash_lists_each_deleted_song_folder_with_its_path_and_time() {
    let clock = ManualClock::new();
    let app = app_with(TestApp::builder().clock(&clock)).await;
    let cookie = app.unlock().await;
    assert_eq!(trash(&app).await, []);

    delete(&app, &cookie, song_id(&app, "Solo").await).await;
    let solo_deleted = millis(clock.clock().now());
    clock.advance(Duration::from_secs(60));
    delete(&app, &cookie, song_id(&app, "Encore").await).await;

    let listed = trash(&app).await;
    let rows: Vec<(&str, i64)> = listed
        .iter()
        .map(|t| (t.original_path.as_str(), t.deleted_ms))
        .collect();
    assert_eq!(
        rows,
        [
            ("Encore", solo_deleted + 60_000),
            ("Older/Solo", solo_deleted)
        ],
        "the most recently deleted first"
    );
}

#[tokio::test]
async fn a_restore_needs_an_unlock_and_moves_nothing_without_one() {
    let app = app_with(TestApp::builder()).await;
    let cookie = app.unlock().await;
    delete(&app, &cookie, song_id(&app, "Solo").await).await;
    let trashed = trash(&app).await[0].id;

    let (status, body) = restore(&app, None, trashed).await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let error: UserMessage = serde_json::from_str(&body).unwrap();
    assert_eq!(error, UserMessage::UnlockRequired);
    assert!(!app.songs_dir().join("Older/Solo").exists());
    assert_eq!(ledger(&app), ["Older/Solo"]);
}

#[tokio::test]
async fn a_restored_song_is_back_at_its_original_path_in_the_index_with_its_records() {
    let app = app_with(TestApp::builder().test_routes()).await;
    let cookie = app.unlock().await;
    let profile = create_profile(&app).await;
    let solo = detail(&app, "Solo").await;
    store_round(&app, &solo, &profile, 5000).await;
    assert_eq!(top_score(&app, "Solo").await, Some(5000));
    // The parent folder goes too, so the restore has to make it again.
    delete(&app, &cookie, solo.id).await;
    std::fs::remove_dir(app.songs_dir().join("Older")).unwrap();
    let trashed = trash(&app).await[0].id;
    let mut socket = app.connect_ws().await;
    assert!(matches!(
        socket.recv().await,
        ServerMessage::LiveState { .. }
    ));

    let (status, body) = restore(&app, Some(&cookie), trashed).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    // Whole, back where it was; the trash and its ledger row are empty.
    assert_eq!(
        files(&app.songs_dir().join("Older/Solo")),
        ["extras/notes.md", "song.mp3", "song.txt"]
    );
    assert_eq!(
        std::fs::read(app.songs_dir().join("Older/Solo/extras/notes.md")).unwrap(),
        b"kept"
    );
    assert_eq!(trash_entries(&app), Vec::<String>::new());
    assert_eq!(ledger(&app), Vec::<String>::new());
    assert_eq!(trash(&app).await, []);

    // Straight to the index: no scan, one notice, the Song and its
    // Score records back.
    assert_eq!(
        socket.recv().await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::Library]
        }
    );
    assert_eq!(titles(&app).await, ["Encore", "Solo"]);
    let scan: openstar_protocol::library::ScanStatus = app.get_json("/api/library/scan").await;
    assert_eq!(scan.finished, 1, "the restore ran no scan");
    assert_eq!(
        top_score(&app, "Solo").await,
        Some(5000),
        "the identity is present again"
    );

    // A second restore of the same row finds nothing.
    let (status, body) = restore(&app, Some(&cookie), trashed).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(refusal(&body), UserMessage::NotInTrash);
}

#[tokio::test]
async fn a_restore_onto_an_existing_folder_is_refused_and_writes_nothing() {
    let app = app_with(TestApp::builder()).await;
    let cookie = app.unlock().await;
    delete(&app, &cookie, song_id(&app, "Solo").await).await;
    let trashed = trash(&app).await[0].id;
    let entry = trash_entries(&app);
    // A new folder of that name, empty or not.
    for leave_empty in [true, false] {
        let taken = app.songs_dir().join("Older/Solo");
        std::fs::create_dir_all(&taken).unwrap();
        if !leave_empty {
            std::fs::write(taken.join("other.md"), b"other").unwrap();
        }
        let songs_before = files(app.songs_dir());
        let trash_before = files(&app.appdata_dir().join("trash"));

        let (status, body) = restore(&app, Some(&cookie), trashed).await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            refusal(&body),
            UserMessage::RestoreFolderExists {
                path: "Older/Solo".into()
            }
        );
        assert_eq!(files(app.songs_dir()), songs_before);
        assert_eq!(files(&app.appdata_dir().join("trash")), trash_before);
        assert_eq!(trash_entries(&app), entry);
        assert_eq!(ledger(&app), ["Older/Solo"]);
        assert_eq!(titles(&app).await, ["Encore"]);
    }
}

#[tokio::test]
async fn a_restore_of_a_ledger_row_whose_folder_is_missing_drops_the_row() {
    let app = app_with(TestApp::builder()).await;
    let cookie = app.unlock().await;
    delete(&app, &cookie, song_id(&app, "Solo").await).await;
    let trashed = trash(&app).await[0].id;
    // A crash between the ledger row and the move leaves a row with no folder.
    std::fs::remove_dir_all(app.appdata_dir().join("trash").join(trashed.0.to_string())).unwrap();

    assert_eq!(trash(&app).await, [], "a row with no folder is not listed");
    let (status, body) = restore(&app, Some(&cookie), trashed).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(refusal(&body), UserMessage::NotInTrash);
    assert_eq!(ledger(&app), Vec::<String>::new());
    assert!(!app.songs_dir().join("Older/Solo").exists());
}

/// Waits up to ten seconds for the ledger to hold `expected`.
async fn ledger_becomes(app: &TestApp, expected: &[&str]) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while ledger(app) != expected {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the ledger is {:?}, not {expected:?}",
            ledger(app)
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn a_trashed_folder_and_its_ledger_row_are_purged_30_days_after_the_delete() {
    let clock = ManualClock::new();
    let mut app = app_with(TestApp::builder().clock(&clock)).await;
    let cookie = app.unlock().await;
    delete(&app, &cookie, song_id(&app, "Solo").await).await;
    clock.advance(Duration::from_secs(60));
    delete(&app, &cookie, song_id(&app, "Encore").await).await;
    let encore = trash(&app).await[0].id;
    let solo = trash(&app).await[1].id;
    // A row whose folder a crash left missing goes at the next purge too.
    std::fs::remove_dir_all(app.appdata_dir().join("trash").join(encore.0.to_string())).unwrap();

    // Just before 30 days: kept (only the row with no folder goes).
    clock.advance(KEPT_FOR - Duration::from_secs(61));
    app.restart().await;
    ledger_becomes(&app, &["Older/Solo"]).await;
    assert_eq!(trash_entries(&app), [solo.0.to_string()]);

    // 30 days after the delete: the next start's purge removes it.
    clock.advance(Duration::from_secs(1));
    app.restart().await;
    ledger_becomes(&app, &[]).await;
    assert_eq!(trash_entries(&app), Vec::<String>::new());
    assert_eq!(trash(&app).await, []);
    assert_eq!(titles(&app).await, Vec::<String>::new());
}
