//! Deleting a Song to the trash (#190), through the real app over HTTP and
//! WebSocket, with every effect checked on disk: the whole folder moves to
//! `/appdata/trash/`, the trash ledger records where it was and when, the
//! index forgets the Song, and its queued Requests drop with a change event.
//! A delete that would take another Song with it, or that hits the Song
//! playing now, is refused and moves nothing.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use openstar::clock::ManualClock;
use openstar_protocol::admin::{ApiError, ApiErrorCode};
use openstar_protocol::library::{SongId, SongList};
use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey, Profile};
use openstar_protocol::{
    Actor, ChangeEvent, ChangeTopic, ClientMessage, JoinAs, PartyEvent, PartySnapshot, PhoneId,
    RequestChange, RequestId, ServerMessage, SongControl, UserMessage,
};
use openstar_test_harness::{TestApp, TestAppBuilder, WsClient};
use reqwest::StatusCode;

fn write_song(folder: &Path, txt: &str, title: &str) {
    std::fs::create_dir_all(folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join(txt),
        format!("#ARTIST:Placeholder\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n"),
    )
    .unwrap();
}

/// An app whose Library is laid out by `lay_out`; returns it and the id of
/// each listed Song by title.
async fn app_with(
    builder: TestAppBuilder,
    lay_out: impl FnOnce(&Path),
) -> (TestApp, Vec<(String, SongId)>) {
    let mut app = builder.start().await;
    lay_out(app.songs_dir());
    app.restart().await;
    let songs = app.get_json::<SongList>("/api/songs").await.songs;
    let ids = songs.into_iter().map(|s| (s.title, s.id)).collect();
    (app, ids)
}

fn id(ids: &[(String, SongId)], title: &str) -> SongId {
    ids.iter().find(|(t, _)| t == title).unwrap().1
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

async fn delete(app: &TestApp, cookie: Option<&str>, id: SongId) -> (StatusCode, Option<String>) {
    let mut request = app.http().delete(app.url(&format!("/api/songs/{}", id.0)));
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let response = request.send().await.unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    (status, (!body.is_empty()).then_some(body))
}

fn refusal(body: Option<String>) -> UserMessage {
    serde_json::from_str(&body.expect("a refusal has a body")).unwrap()
}

/// The trash ledger: (original path, deleted at in ms since the epoch).
fn ledger(app: &TestApp) -> Vec<(String, i64)> {
    let db =
        rusqlite::Connection::open(app.appdata_dir().join(openstar::db::DATABASE_FILE)).unwrap();
    let mut statement = db
        .prepare("SELECT original_path, deleted_ms FROM trash ORDER BY id")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
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

#[tokio::test]
async fn the_delete_needs_an_unlock() {
    let (app, ids) = app_with(TestApp::builder(), |songs| {
        write_song(&songs.join("Solo"), "song.txt", "Solo");
    })
    .await;
    let before = files(app.songs_dir());

    let (status, body) = delete(&app, None, id(&ids, "Solo")).await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let error: ApiError = serde_json::from_str(&body.unwrap()).unwrap();
    assert_eq!(error.code, ApiErrorCode::UnlockRequired);
    assert_eq!(files(app.songs_dir()), before);
}

#[tokio::test]
async fn a_deleted_song_moves_whole_to_the_trash_and_leaves_the_index() {
    let clock = ManualClock::new();
    clock.advance(Duration::from_secs(3600));
    let (app, ids) = app_with(TestApp::builder().clock(&clock), |songs| {
        write_song(&songs.join("Older/Solo"), "song.txt", "Solo");
        std::fs::create_dir_all(songs.join("Older/Solo/extras")).unwrap();
        std::fs::write(songs.join("Older/Solo/extras/notes.md"), b"kept").unwrap();
        std::fs::write(songs.join("Older/Solo/song.txt.orig"), b"original").unwrap();
        write_song(&songs.join("Encore"), "song.txt", "Encore");
    })
    .await;
    let solo = id(&ids, "Solo");
    let cookie = app.unlock().await;
    let mut socket = app.connect_ws().await;
    assert!(matches!(
        socket.recv().await,
        ServerMessage::LiveState { .. }
    ));

    let (status, body) = delete(&app, Some(&cookie), solo).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");

    // Gone from the Library, its parent folder and the other Song kept.
    assert!(!app.songs_dir().join("Older/Solo").exists());
    assert!(app.songs_dir().join("Older").is_dir());
    assert_eq!(
        files(app.songs_dir()),
        ["Encore/song.mp3", "Encore/song.txt"]
    );
    // Whole, in the trash in /appdata.
    let trash = app.appdata_dir().join("trash");
    let trashed: Vec<String> = files(&trash);
    assert_eq!(trashed.len(), 4, "{trashed:?}");
    let folder: PathBuf = trash.join(trashed[0].split('/').next().unwrap());
    assert_eq!(
        files(&folder),
        ["extras/notes.md", "song.mp3", "song.txt", "song.txt.orig"]
    );
    assert_eq!(
        std::fs::read(folder.join("extras/notes.md")).unwrap(),
        b"kept"
    );
    assert_eq!(
        ledger(&app),
        [("Older/Solo".to_owned(), millis(clock.clock().now()))]
    );

    // Straight to the index: no scan, one notice, the Song no longer there.
    assert_eq!(
        socket.recv().await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::Library]
        }
    );
    let listed = app.get_json::<SongList>("/api/songs").await.songs;
    assert_eq!(
        listed.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(),
        ["Encore"]
    );
    let response = app
        .http()
        .get(app.url(&format!("/api/songs/{}", solo.0)))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let scan: openstar_protocol::library::ScanStatus = app.get_json("/api/library/scan").await;
    assert_eq!(scan.finished, 1, "the delete ran no scan");

    // A second delete of the same Song finds nothing.
    assert_eq!(
        refusal(delete(&app, Some(&cookie), solo).await.1),
        UserMessage::SongNotInLibrary
    );
}

#[tokio::test]
async fn a_delete_is_refused_for_a_folder_holding_another_txt_and_moves_nothing() {
    let (app, ids) = app_with(TestApp::builder(), |songs| {
        // Two Songs in one folder.
        write_song(&songs.join("Pair"), "one.txt", "One");
        write_song(&songs.join("Pair"), "two.txt", "Two");
        // A Song beside a rejected file, deeper in its folder.
        write_song(&songs.join("Beside"), "song.txt", "Beside");
        std::fs::create_dir_all(songs.join("Beside/old")).unwrap();
        std::fs::write(songs.join("Beside/old/broken.TXT"), b"not a song").unwrap();
    })
    .await;
    let cookie = app.unlock().await;
    let before = files(app.songs_dir());

    for (title, other) in [
        ("One", "Pair/two.txt"),
        ("Two", "Pair/one.txt"),
        ("Beside", "Beside/old/broken.TXT"),
    ] {
        let (status, body) = delete(&app, Some(&cookie), id(&ids, title)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{title}");
        assert_eq!(
            refusal(body),
            UserMessage::SongFolderShared {
                other_txt: other.to_owned()
            },
            "{title}"
        );
    }
    assert_eq!(files(app.songs_dir()), before);
    assert!(files(&app.appdata_dir().join("trash")).is_empty());
    assert!(ledger(&app).is_empty());
    assert_eq!(app.get_json::<SongList>("/api/songs").await.songs.len(), 3);
}

#[tokio::test]
async fn a_delete_is_refused_for_a_txt_in_the_library_root_and_moves_nothing() {
    let (app, ids) = app_with(TestApp::builder(), |songs| {
        write_song(songs, "loose.txt", "Loose");
    })
    .await;
    let cookie = app.unlock().await;
    let before = files(app.songs_dir());

    let (status, body) = delete(&app, Some(&cookie), id(&ids, "Loose")).await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(refusal(body), UserMessage::SongInLibraryRoot);
    assert_eq!(files(app.songs_dir()), before);
    assert!(ledger(&app).is_empty());
}

mod party {
    //! The Party follows a delete: queued Requests drop, the playing Song
    //! cannot be deleted.

    use super::*;

    /// The next message on `socket`, past change notices for HTTP data.
    async fn recv(socket: &mut WsClient) -> ServerMessage {
        loop {
            match socket.recv().await {
                ServerMessage::Changed { .. } => {}
                message => return message,
            }
        }
    }

    async fn party_changed(socket: &mut WsClient) -> (PartySnapshot, ChangeEvent) {
        match recv(socket).await {
            ServerMessage::PartyChanged { party, change } => (party, change),
            other => panic!("expected a Party change, got {other:?}"),
        }
    }

    /// A Stage and one joined Phone; both past what the join sent them.
    async fn stage_and_phone(app: &TestApp) -> (WsClient, WsClient) {
        let mut stage = app.connect_stage().await;
        assert!(matches!(
            recv(&mut stage).await,
            ServerMessage::LiveState { .. }
        ));
        let code = party_changed(&mut stage).await.0.join_code;
        let response = app
            .http()
            .post(app.url("/api/profiles"))
            .json(&NewProfile {
                name: "Bo".into(),
                avatar: Avatar::BuiltIn {
                    key: AvatarKey::Star,
                },
                favourite_colour: PaletteKey::Sky,
            })
            .send()
            .await
            .unwrap();
        let bo: Profile = response.json().await.unwrap();
        let mut phone = app.connect_ws().await;
        assert!(matches!(
            recv(&mut phone).await,
            ServerMessage::LiveState { .. }
        ));
        phone
            .send(&ClientMessage::Join {
                phone_id: PhoneId("4b1d8f0e-0000-4000-8000-000000000001".into()),
                join_code: code,
                join_as: JoinAs::Profile { profile_id: bo.id },
            })
            .await;
        assert!(matches!(
            recv(&mut phone).await,
            ServerMessage::PhoneStatus { .. }
        ));
        party_changed(&mut phone).await;
        party_changed(&mut stage).await;
        (stage, phone)
    }

    async fn add(stage: &mut WsClient, phone: &mut WsClient, song: SongId) -> RequestId {
        phone
            .send(&ClientMessage::AddRequest {
                song_id: song,
                requested_players: None,
            })
            .await;
        let (_, change) = party_changed(phone).await;
        party_changed(stage).await;
        let PartyEvent::RequestAdded(added) = change.event else {
            panic!("expected a Request added, got {change:?}");
        };
        added.request_id
    }

    #[tokio::test]
    async fn a_song_deleted_while_queued_drops_its_requests_with_a_change_event() {
        let (app, ids) = app_with(TestApp::builder(), |songs| {
            write_song(&songs.join("Solo"), "song.txt", "Solo");
            write_song(&songs.join("Encore"), "song.txt", "Encore");
        })
        .await;
        let (solo, encore) = (id(&ids, "Solo"), id(&ids, "Encore"));
        let (mut stage, mut phone) = stage_and_phone(&app).await;
        let first = add(&mut stage, &mut phone, solo).await;
        let second = add(&mut stage, &mut phone, encore).await;
        let cookie = app.unlock().await;

        let (status, body) = delete(&app, Some(&cookie), solo).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");

        for socket in [&mut stage, &mut phone] {
            let (party, change) = party_changed(socket).await;
            assert_eq!(
                change,
                ChangeEvent {
                    actor: Actor::Admin,
                    event: PartyEvent::RequestDroppedSongGone(RequestChange {
                        request_id: first,
                        song_id: solo,
                        title: "Solo".into(),
                    }),
                }
            );
            assert_eq!(party.head, Some(second));
            let queued: Vec<RequestId> = party.queue.iter().map(|r| r.request_id).collect();
            assert_eq!(queued, vec![second]);
        }
    }

    #[tokio::test]
    async fn a_delete_is_refused_while_the_song_plays_and_moves_nothing() {
        let (app, ids) = app_with(TestApp::builder(), |songs| {
            write_song(&songs.join("Solo"), "song.txt", "Solo");
        })
        .await;
        let solo = id(&ids, "Solo");
        let (mut stage, mut phone) = stage_and_phone(&app).await;
        let request = add(&mut stage, &mut phone, solo).await;
        phone
            .send(&ClientMessage::ControlSong {
                request_id: request,
                control: SongControl::Start,
            })
            .await;
        let (now, _) = party_changed(&mut phone).await;
        assert_eq!(now.playing.map(|p| p.song_id), Some(solo));
        let before = files(app.songs_dir());
        let cookie = app.unlock().await;

        let (status, body) = delete(&app, Some(&cookie), solo).await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(refusal(body), UserMessage::SongPlaying);
        assert_eq!(files(app.songs_dir()), before);
        assert!(ledger(&app).is_empty());
        assert_eq!(app.get_json::<SongList>("/api/songs").await.songs.len(), 1);
        drop((stage, phone));
    }
}
