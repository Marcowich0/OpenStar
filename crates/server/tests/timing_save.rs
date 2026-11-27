//! Saving a Timing edit with its Original, and Restore Original (#188),
//! through the real app over HTTP, with every effect checked on disk.
//!
//! This is the first code that changes an existing file in the Library, so
//! each safety property has a test here that fails if it is dropped: the
//! Original kept once, byte for byte; the atomic replace; the conflict
//! refusal; the smallest change to the `.txt`.

use std::path::PathBuf;

use openstar_protocol::admin::UnlockRequest;
use openstar_protocol::library::{SongDetail, SongId, SongList};
use openstar_protocol::song::{ChangedLine, TimingOperation, TimingPreview, TxtVersion};
use openstar_protocol::{ChangeTopic, ServerMessage};
use openstar_test_harness::TestApp;
use reqwest::StatusCode;
use serde_json::{Value, json};

/// A Song shaped like the owner's Library: LF in the headers, CRLF in the
/// body. Line 5 is `#GAP`, line 7 the second Note, line 8 a Line end.
const TXT: &[u8] = b"#ARTIST:Placeholder\n#TITLE:Timing\n#MP3:song.mp3\n#BPM:200\n#GAP:1000\n\
: 0 4 0 La\r\n: 4 4 2 lo\r\n- 10\r\n: 12 4 0 li\r\nE\r\n";

/// [`TXT`] with `#GAP` set to 1.5 s and the second Note moved to beat 5.
const EDITED: &[u8] = b"#ARTIST:Placeholder\n#TITLE:Timing\n#MP3:song.mp3\n#BPM:200\n#GAP:1500\n\
: 0 4 0 La\r\n: 5 4 2 lo\r\n- 10\r\n: 12 4 0 li\r\nE\r\n";

fn edit() -> Vec<TimingOperation> {
    vec![
        TimingOperation::SetGap { seconds: 1.5 },
        TimingOperation::SetNoteStart { line: 7, start: 5 },
    ]
}

struct Song {
    app: TestApp,
    id: SongId,
}

impl Song {
    /// An app whose Library holds one playable Song with [`TXT`].
    async fn start() -> Self {
        Self::start_with(TestApp::builder()).await
    }

    async fn start_with(builder: openstar_test_harness::TestAppBuilder) -> Self {
        let mut app = builder.start().await;
        let folder = app.songs_dir().join("Placeholder - Timing");
        std::fs::create_dir(&folder).unwrap();
        openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
        std::fs::write(folder.join("song.txt"), TXT).unwrap();
        app.restart().await;
        let list: SongList = app.get_json("/api/songs").await;
        assert_eq!(list.songs.len(), 1, "the Song plays");
        let id = list.songs[0].id;
        Self { app, id }
    }

    fn folder(&self) -> PathBuf {
        self.app.songs_dir().join("Placeholder - Timing")
    }

    fn txt(&self) -> PathBuf {
        self.folder().join("song.txt")
    }

    fn orig(&self) -> PathBuf {
        self.folder().join("song.txt.orig")
    }

    /// The folder's file names, sorted.
    fn files(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.folder())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    async fn post(
        &self,
        path: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = self.app.http().post(self.app.url(path));
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        let value = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        (status, value)
    }

    async fn preview(&self, operations: &[TimingOperation]) -> (StatusCode, Value) {
        let path = format!("/api/songs/{}/timing/preview", self.id.0);
        self.post(&path, None, Some(json!({ "operations": operations })))
            .await
    }

    async fn base(&self) -> TxtVersion {
        let (status, body) = self.preview(&[]).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        serde_json::from_value::<TimingPreview>(body).unwrap().base
    }

    async fn save_as(
        &self,
        cookie: Option<&str>,
        base: &TxtVersion,
        operations: &[TimingOperation],
    ) -> (StatusCode, Value) {
        let path = format!("/api/songs/{}/timing", self.id.0);
        self.post(
            &path,
            cookie,
            Some(json!({ "base": base, "operations": operations })),
        )
        .await
    }

    async fn save(&self, operations: &[TimingOperation]) -> (StatusCode, Value) {
        let base = self.base().await;
        let cookie = self.unlock().await;
        self.save_as(Some(&cookie), &base, operations).await
    }

    async fn restore(&self, cookie: Option<&str>) -> (StatusCode, Value) {
        let path = format!("/api/songs/{}/restore-original", self.id.0);
        self.post(&path, cookie, None).await
    }

    async fn unlock(&self) -> String {
        let response = self
            .app
            .http()
            .post(self.app.url("/api/unlock"))
            .json(&UnlockRequest {
                pin: "1234".to_owned(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()["set-cookie"].to_str().unwrap();
        cookie.split(';').next().unwrap().trim().to_owned()
    }
}

#[tokio::test]
async fn the_preview_lists_exactly_the_lines_that_change() {
    let song = Song::start().await;
    let (status, body) = song.preview(&edit()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let preview: TimingPreview = serde_json::from_value(body).unwrap();
    assert_eq!(
        preview.changed,
        vec![
            ChangedLine {
                line: 5,
                old: Some("#GAP:1000".into()),
                new: Some("#GAP:1500".into()),
            },
            ChangedLine {
                line: 7,
                old: Some(": 4 4 2 lo".into()),
                new: Some(": 5 4 2 lo".into()),
            },
        ]
    );
    // SHA-256 of TXT, computed outside OpenStar (`sha256sum`).
    assert_eq!(preview.base, TxtVersion(TXT_SHA256.into()));
    assert_eq!(
        std::fs::read(song.txt()).unwrap(),
        TXT,
        "a preview writes nothing"
    );
    assert_eq!(song.files(), ["song.mp3", "song.txt"]);
}

const TXT_SHA256: &str = "06c1e2f7e0f1d96ffa25d9ee9e7ac224323ac5ad500704b98d83c4beb5e0260f";

#[tokio::test]
async fn the_preview_refuses_an_operation_the_timing_editor_does_not_send() {
    let song = Song::start().await;
    let path = format!("/api/songs/{}/timing/preview", song.id.0);
    let (status, _) = song
        .post(
            &path,
            None,
            Some(json!({ "operations": [{ "op": "setNotePitch", "line": 7, "pitch": 3 }] })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, body) = song
        .preview(&[TimingOperation::SetNoteStart { line: 8, start: 3 }])
        .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "line 8 is no Note"
    );
    assert_eq!(body, json!({ "code": "invalidMessage" }));
}

fn inode(path: &std::path::Path) -> u64 {
    use std::os::unix::fs::MetadataExt as _;
    std::fs::metadata(path).unwrap().ino()
}

async fn gap_seconds(song: &Song) -> f64 {
    let detail: SongDetail = song
        .app
        .get_json(&format!("/api/songs/{}", song.id.0))
        .await;
    assert_eq!(detail.id, song.id);
    detail.song.headers.gap_seconds
}

#[tokio::test]
async fn a_save_keeps_the_original_once_and_changes_only_the_touched_lines() {
    let song = Song::start().await;
    let before = inode(&song.txt());

    let (status, body) = song.save(&edit()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let saved: TimingPreview = serde_json::from_value(body).unwrap();
    assert_eq!(saved.changed.len(), 2);
    assert_eq!(
        std::fs::read(song.txt()).unwrap(),
        EDITED,
        "only lines 5 and 7 changed"
    );
    assert_eq!(
        std::fs::read(song.orig()).unwrap(),
        TXT,
        "the Original, byte for byte"
    );
    assert_eq!(
        song.files(),
        ["song.mp3", "song.txt", "song.txt.orig"],
        "no temporary file is left"
    );
    assert_ne!(
        inode(&song.txt()),
        before,
        "a new file was renamed over the .txt, not written in place"
    );
    assert_eq!(
        saved.base,
        song.base().await,
        "the answer names the written file"
    );

    // Applied straight to the index, with the same Song id.
    assert!((gap_seconds(&song).await - 1.5).abs() < 1e-9);

    // A second edit keeps the first Original.
    let (status, body) = song.save(&[TimingOperation::SetGap { seconds: 2.0 }]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        std::fs::read(song.orig()).unwrap(),
        TXT,
        "an Original is never overwritten"
    );
    assert_eq!(
        std::fs::read(song.txt()).unwrap(),
        String::from_utf8(EDITED.to_vec())
            .unwrap()
            .replace("#GAP:1500", "#GAP:2000")
            .into_bytes()
    );
    assert!((gap_seconds(&song).await - 2.0).abs() < 1e-9);
}

#[tokio::test]
async fn a_save_that_changes_nothing_writes_nothing() {
    let song = Song::start().await;
    let (status, body) = song.save(&[TimingOperation::SetGap { seconds: 1.0 }]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["changed"], json!([]));
    assert_eq!(song.files(), ["song.mp3", "song.txt"]);
}

#[tokio::test]
async fn a_save_pushes_a_library_change_notice() {
    let song = Song::start().await;
    let mut socket = song.app.connect_ws().await;
    assert!(matches!(
        socket.recv().await,
        ServerMessage::LiveState { .. }
    ));
    let (status, _) = song.save(&edit()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        socket.recv().await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::Library]
        }
    );
}

#[tokio::test]
async fn saving_and_restoring_need_an_unlock() {
    let song = Song::start().await;
    let base = song.base().await;
    let (status, body) = song.save_as(None, &base, &edit()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "code": "unlockRequired" }));
    let (status, _) = song.restore(None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(std::fs::read(song.txt()).unwrap(), TXT);
    assert_eq!(song.files(), ["song.mp3", "song.txt"]);
}

/// Writes `bytes` over the `.txt` the way another program would, then sets
/// its mtime to `mtime`.
fn foreign_write(path: &std::path::Path, bytes: &[u8], mtime: std::time::SystemTime) {
    std::fs::write(path, bytes).unwrap();
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(mtime)
        .unwrap();
}

async fn refused_as_changed(song: &Song, base: &TxtVersion) {
    let cookie = song.unlock().await;
    let (status, body) = song.save_as(Some(&cookie), base, &edit()).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body, json!({ "code": "songFileChanged" }));
    assert!(!song.orig().exists(), "a refused save keeps no Original");
}

#[tokio::test]
async fn a_save_is_refused_when_the_content_changed_on_disk() {
    let song = Song::start().await;
    let base = song.base().await;
    let mtime = std::fs::metadata(song.txt()).unwrap().modified().unwrap();
    // Same size, same mtime: only the content hash tells.
    let foreign = String::from_utf8(TXT.to_vec())
        .unwrap()
        .replace("lo", "lu")
        .into_bytes();
    foreign_write(&song.txt(), &foreign, mtime);
    assert_eq!(
        std::fs::metadata(song.txt()).unwrap().modified().unwrap(),
        mtime
    );
    refused_as_changed(&song, &base).await;
    assert_eq!(
        std::fs::read(song.txt()).unwrap(),
        foreign,
        "the other program's change stays"
    );
    // Checked against what the index loaded, not only against the base.
    let (status, body) = song.preview(&edit()).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body, json!({ "code": "songFileChanged" }));
}

#[tokio::test]
async fn a_save_is_refused_when_the_mtime_changed_on_disk() {
    let song = Song::start().await;
    let base = song.base().await;
    let later = std::fs::metadata(song.txt()).unwrap().modified().unwrap()
        + std::time::Duration::from_secs(5);
    foreign_write(&song.txt(), TXT, later);
    refused_as_changed(&song, &base).await;
    assert_eq!(std::fs::read(song.txt()).unwrap(), TXT);
}

#[tokio::test]
async fn a_save_is_refused_when_its_preview_was_of_another_version() {
    let song = Song::start().await;
    let stale = song.base().await;
    let (status, _) = song.save(&[TimingOperation::SetGap { seconds: 2.0 }]).await;
    assert_eq!(status, StatusCode::OK);
    let written = std::fs::read(song.txt()).unwrap();
    let cookie = song.unlock().await;
    let (status, body) = song.save_as(Some(&cookie), &stale, &edit()).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body, json!({ "code": "songFileChanged" }));
    assert_eq!(std::fs::read(song.txt()).unwrap(), written);
}

#[tokio::test]
async fn restore_original_puts_the_original_back_and_removes_it() {
    let song = Song::start().await;
    let originals = || async {
        song.app
            .get_json::<Vec<SongId>>("/api/library/originals")
            .await
    };
    assert_eq!(originals().await, []);
    let cookie = song.unlock().await;
    let (status, body) = song.restore(Some(&cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "nothing to restore");
    assert_eq!(body, json!({ "code": "noOriginal" }));

    assert_eq!(song.save(&edit()).await.0, StatusCode::OK);
    assert_eq!(originals().await, [song.id]);
    let edited_inode = inode(&song.txt());

    let mut socket = song.app.connect_ws().await;
    assert!(matches!(
        socket.recv().await,
        ServerMessage::LiveState { .. }
    ));
    let (status, body) = song.restore(Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!(TXT_SHA256), "the restored file's version");
    assert_eq!(
        std::fs::read(song.txt()).unwrap(),
        TXT,
        "the original bytes"
    );
    assert_eq!(
        song.files(),
        ["song.mp3", "song.txt"],
        "the Original is gone"
    );
    assert_ne!(inode(&song.txt()), edited_inode, "replaced by a rename");
    assert_eq!(
        socket.recv().await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::Library]
        }
    );
    assert_eq!(originals().await, []);
    assert!(
        (gap_seconds(&song).await - 1.0).abs() < 1e-9,
        "the index follows"
    );

    // The next edit keeps a fresh Original: the restored file.
    let (status, _) = song.save(&[TimingOperation::SetGap { seconds: 3.0 }]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(std::fs::read(song.orig()).unwrap(), TXT);
}

mod playing {
    //! The Song playing now cannot be saved or restored.

    use super::*;
    use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey, Profile};
    use openstar_protocol::{
        ClientMessage, JoinAs, PartySnapshot, PhoneId, SongControl, UserMessage,
    };
    use openstar_test_harness::WsClient;

    async fn recv(socket: &mut WsClient) -> ServerMessage {
        loop {
            match socket.recv().await {
                ServerMessage::Changed { .. } => {}
                message => return message,
            }
        }
    }

    async fn party(socket: &mut WsClient) -> PartySnapshot {
        match recv(socket).await {
            ServerMessage::PartyChanged { party, .. } => party,
            other => panic!("expected the Party, got {other:?}"),
        }
    }

    /// Starts `song` on a new Stage with one Phone seated; returns both
    /// sockets so the Song keeps playing.
    async fn start_playing(song: &Song) -> (WsClient, WsClient) {
        let app = &song.app;
        let mut stage = app.connect_stage().await;
        assert!(matches!(
            recv(&mut stage).await,
            ServerMessage::LiveState { .. }
        ));
        let code = party(&mut stage).await.join_code;
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
        party(&mut phone).await;
        party(&mut stage).await;
        phone
            .send(&ClientMessage::AddRequest {
                song_id: song.id,
                requested_players: None,
            })
            .await;
        let request = party(&mut phone).await.line_up.unwrap().request_id;
        party(&mut stage).await;
        phone
            .send(&ClientMessage::ControlSong {
                request_id: request,
                control: SongControl::Start,
            })
            .await;
        let now = party(&mut phone).await;
        assert_eq!(now.playing.map(|p| p.song_id), Some(song.id));
        party(&mut stage).await;
        (stage, phone)
    }

    #[tokio::test]
    async fn the_song_playing_now_cannot_be_saved_or_restored() {
        let song = Song::start().await;
        assert_eq!(song.save(&edit()).await.0, StatusCode::OK);
        let edited = std::fs::read(song.txt()).unwrap();
        let _sockets = start_playing(&song).await;

        let refused = serde_json::to_value(UserMessage::SongPlaying).unwrap();
        let (status, body) = song.save(&[TimingOperation::SetGap { seconds: 2.0 }]).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body, refused);
        let cookie = song.unlock().await;
        let (status, body) = song.restore(Some(&cookie)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body, refused);
        assert_eq!(std::fs::read(song.txt()).unwrap(), edited);
        assert!(song.orig().exists());
        // The preview writes nothing, so it still answers.
        assert_eq!(song.preview(&edit()).await.0, StatusCode::OK);
    }
}

mod high_scores {
    //! Score records and High scores are untouched by a save and a restore;
    //! entries sung before a save carry the "older timing" mark.

    use super::*;
    use openstar_protocol::party::{PartyId, RequestId};
    use openstar_protocol::profile::{
        Avatar, AvatarKey, Difficulty, NewProfile, PaletteKey, Profile,
    };
    use openstar_protocol::scoring::{
        BeatRange, BeatValue, MicKind, PlayerScore, RoundEnd, RoundMode, RoundOutcome, ScorePlayer,
        SongHighScores,
    };

    async fn store_a_record(song: &Song) {
        let app = &song.app;
        let detail: SongDetail = app.get_json(&format!("/api/songs/{}", song.id.0)).await;
        let response = app
            .http()
            .post(app.url("/api/profiles"))
            .json(&NewProfile {
                name: "Ada".into(),
                avatar: Avatar::BuiltIn {
                    key: AvatarKey::Star,
                },
                favourite_colour: PaletteKey::Cherry,
            })
            .send()
            .await
            .unwrap();
        let ada: Profile = response.json().await.unwrap();
        let outcome = RoundOutcome {
            song_id: song.id,
            note_fingerprint: detail.note_fingerprint,
            request_id: RequestId(1),
            party_id: PartyId("party-1".into()),
            mode: RoundMode::Normal,
            started_at_ms: 1_700_000_000_000,
            ended: RoundEnd::Played,
            scores: vec![PlayerScore {
                player: ScorePlayer::Profile { profile_id: ada.id },
                voice: 0,
                difficulty: Difficulty::Hard,
                total: 5000,
                notes: 2500,
                golden: 0,
                line_bonus: 2500,
                mic_kind: MicKind::Phone,
                unfinished: false,
                mic_lost: false,
                beat_range: BeatRange {
                    first_beat: 0,
                    last_beat: 7,
                },
                beat_values: vec![BeatValue::Pitch { pitch: 60.0 }; 8],
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

    /// (total, older timing) of every entry in the Hard table of Voice 0.
    async fn hard(song: &Song) -> Vec<(u32, bool)> {
        let scores: SongHighScores = song
            .app
            .get_json(&format!("/api/songs/{}/high-scores", song.id.0))
            .await;
        scores
            .tables
            .iter()
            .find(|t| t.voice == 0 && t.difficulty == Difficulty::Hard)
            .unwrap()
            .entries
            .iter()
            .map(|e| (e.total, e.older_timing))
            .collect()
    }

    #[tokio::test]
    async fn high_scores_survive_a_save_and_a_restore() {
        let song = Song::start_with(TestApp::builder().test_routes()).await;
        store_a_record(&song).await;
        assert_eq!(hard(&song).await, [(5000, false)]);
        assert_eq!(song.save(&edit()).await.0, StatusCode::OK);
        assert_eq!(
            hard(&song).await,
            [(5000, true)],
            "kept, sung to the older timing"
        );
        let cookie = song.unlock().await;
        assert_eq!(song.restore(Some(&cookie)).await.0, StatusCode::OK);
        assert_eq!(
            hard(&song).await,
            [(5000, false)],
            "the timing it was sung to is back"
        );
    }
}
