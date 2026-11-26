//! The Song playing now can't be fixed (#225): while a Song plays on the
//! Stage the server refuses a Phone's fit start, a Timing edit save and
//! Restore Original for it, and a save is refused for a Song that started
//! playing after the editor opened it, even once it has stopped. Other Songs
//! are not affected.

use std::time::Duration;

use openstar::clock::ManualClock;
use openstar_protocol::library::{SongId, SongList};
use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey, Profile};
use openstar_protocol::song::{TimingOperation, TimingPreview, TxtVersion};
use openstar_protocol::{
    ClientMessage, JoinAs, PartySnapshot, PhoneId, RequestId, ServerMessage, SongControl,
    UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};
use reqwest::StatusCode;
use serde_json::{Value, json};

const TXT: &[u8] = b"#ARTIST:Placeholder\n#TITLE:TITLE\n#MP3:song.mp3\n#BPM:200\n#GAP:1000\n\
: 0 4 0 La\n: 4 4 2 lo\n- 10\n: 12 4 0 li\nE\n";

const FOLDERS: [&str; 2] = ["Placeholder - One", "Placeholder - Two"];

async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. } | ServerMessage::SongProgress { .. } => {}
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

/// Two playable Songs, a Stage with its Party, and a Phone joined as Bo, on
/// a manual clock.
struct Party {
    app: TestApp,
    clock: ManualClock,
    one: SongId,
    two: SongId,
    stage: WsClient,
    phone: WsClient,
}

impl Party {
    async fn start() -> Self {
        let clock = ManualClock::new();
        let mut app = TestApp::builder().clock(&clock).start().await;
        for folder in FOLDERS {
            let dir = app.songs_dir().join(folder);
            std::fs::create_dir(&dir).unwrap();
            openstar_test_harness::placeholder_media(&dir.join("song.mp3")).unwrap();
            let title = folder.trim_start_matches("Placeholder - ");
            let txt = String::from_utf8(TXT.to_vec())
                .unwrap()
                .replace("TITLE", title);
            std::fs::write(dir.join("song.txt"), txt).unwrap();
        }
        app.restart().await;
        let list: SongList = app.get_json("/api/songs").await;
        let id = |title: &str| {
            list.songs
                .iter()
                .find(|s| s.title == title)
                .map(|s| s.id)
                .unwrap()
        };
        let (one, two) = (id("One"), id("Two"));

        let mut stage = app.connect_stage().await;
        assert!(matches!(
            recv(&mut stage).await,
            ServerMessage::LiveState { .. }
        ));
        let code = party(&mut stage).await.join_code;
        let bo: Profile = app
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
            .unwrap()
            .json()
            .await
            .unwrap();
        let mut phone = app.connect_ws().await;
        assert!(matches!(
            recv(&mut phone).await,
            ServerMessage::LiveState { .. }
        ));
        phone
            .send(&ClientMessage::Join {
                phone_id: PhoneId("4b1d8f0e-0000-4000-8000-000000000225".into()),
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
        Self {
            app,
            clock,
            one,
            two,
            stage,
            phone,
        }
    }

    fn tick(&self) {
        self.clock.advance(Duration::from_secs(1));
    }

    /// Queues Song `song` and starts it; answers its Request.
    async fn play(&mut self, song: SongId) -> RequestId {
        self.phone
            .send(&ClientMessage::AddRequest {
                song_id: song,
                requested_players: None,
            })
            .await;
        let request = party(&mut self.phone).await.line_up.unwrap().request_id;
        party(&mut self.stage).await;
        self.control(request, SongControl::Start).await;
        request
    }

    async fn control(&mut self, request: RequestId, control: SongControl) {
        self.phone
            .send(&ClientMessage::ControlSong {
                request_id: request,
                control,
            })
            .await;
        party(&mut self.phone).await;
        party(&mut self.stage).await;
        // The Stage is told to act on it.
        assert!(matches!(
            recv(&mut self.stage).await,
            ServerMessage::ControlSong { .. }
        ));
    }

    async fn post(&self, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let cookie = self.app.unlock().await;
        let mut request = self
            .app
            .http()
            .post(self.app.url(path))
            .header("cookie", cookie);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    /// What the editor reads when it opens Song `song`: when it loaded it.
    async fn open(&self, song: SongId) -> Value {
        let detail: Value = self.app.get_json(&format!("/api/songs/{}", song.0)).await;
        let loaded = detail["loadedAtMs"].clone();
        assert!(loaded.is_number(), "the detail says when: {detail}");
        loaded
    }

    async fn base(&self, song: SongId) -> TxtVersion {
        let response = self
            .app
            .http()
            .post(
                self.app
                    .url(&format!("/api/songs/{}/timing/preview", song.0)),
            )
            .json(&json!({ "operations": [] }))
            .send()
            .await
            .unwrap();
        response.json::<TimingPreview>().await.unwrap().base
    }

    async fn save(&self, song: SongId, opened_at: &Value, gap: f64) -> (StatusCode, Value) {
        let body = json!({
            "base": self.base(song).await,
            "operations": [TimingOperation::SetGap { seconds: gap }],
            "openedAtMs": opened_at,
        });
        self.post(&format!("/api/songs/{}/timing", song.0), Some(body))
            .await
    }

    async fn restore(&self, song: SongId) -> (StatusCode, Value) {
        self.post(&format!("/api/songs/{}/restore-original", song.0), None)
            .await
    }

    async fn fit(&self, song: SongId) -> (StatusCode, Value) {
        self.post(&format!("/api/songs/{}/auto-fit", song.0), None)
            .await
    }
}

fn code(message: UserMessage) -> Value {
    serde_json::to_value(message).unwrap()
}

#[tokio::test]
async fn fit_save_and_restore_are_refused_for_the_song_playing_now_only() {
    let mut party = Party::start().await;
    let (one, two) = (party.one, party.two);
    // Both Songs have an Original to restore.
    let opened_one = party.open(one).await;
    let opened_two = party.open(two).await;
    assert_eq!(party.save(one, &opened_one, 1.5).await.0, StatusCode::OK);
    assert_eq!(party.save(two, &opened_two, 1.5).await.0, StatusCode::OK);
    let one_txt = party.app.songs_dir().join(FOLDERS[0]).join("song.txt");
    let edited = std::fs::read(&one_txt).unwrap();
    party.tick();
    party.play(one).await;
    party.tick();

    let playing = code(UserMessage::SongPlaying);
    let (status, body) = party.fit(one).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, playing.clone()));
    let (status, body) = party.save(one, &opened_one, 2.0).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, playing.clone()));
    let (status, body) = party.restore(one).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, playing));
    assert_eq!(std::fs::read(&one_txt).unwrap(), edited, "nothing written");

    // Another Song is not affected.
    let (status, body) = party.save(two, &opened_two, 2.0).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = party.restore(two).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn a_save_is_refused_for_a_song_that_started_after_the_editor_opened_it() {
    let mut party = Party::start().await;
    let one = party.one;
    let opened_before = party.open(one).await;
    party.tick();
    let request = party.play(one).await;
    party.tick();
    party.control(request, SongControl::Skip).await;
    party.tick();

    // It stopped, but it started after this editor opened it.
    let (status, body) = party.save(one, &opened_before, 2.0).await;
    assert_eq!(
        (status, body),
        (
            StatusCode::CONFLICT,
            code(UserMessage::SongStartedSinceOpened)
        )
    );

    // Opened again since, it saves; and Restore Original is not refused.
    let opened_after = party.open(one).await;
    let (status, body) = party.save(one, &opened_after, 2.0).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = party.restore(one).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
