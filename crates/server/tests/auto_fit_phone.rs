//! Auto-fit on a Phone (#223) over real HTTP and WebSocket: starting it is
//! guarded, and accepting it is a Timing edit through the guarded save that
//! changes only `#GAP` and `#BPM` and shows the Stage one toast naming the
//! Party member and the Song.

use openstar_protocol::library::{SongId, SongList};
use openstar_protocol::pitch_track::PitchTrackStart;
use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey, Profile};
use openstar_protocol::song::{TimingOperation, TimingPreview, TxtVersion};
use openstar_protocol::{
    Actor, ChangeEvent, ClientMessage, JoinAs, PartyEvent, PartySnapshot, PhoneId, ServerMessage,
    UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};
use reqwest::StatusCode;
use serde_json::{Value, json};

const TXT: &[u8] = b"#ARTIST:Placeholder\n#TITLE:Fitted\n#MP3:song.mp3\n#BPM:200\n#GAP:1000\n\
: 0 4 0 La\r\n: 4 4 2 lo\r\n- 10\r\n: 12 4 0 li\r\nE\r\n";

/// [`TXT`] after the fit: only `#BPM` and `#GAP` differ.
const FITTED: &[u8] = b"#ARTIST:Placeholder\n#TITLE:Fitted\n#MP3:song.mp3\n#BPM:201.5\n#GAP:1250\n\
: 0 4 0 La\r\n: 4 4 2 lo\r\n- 10\r\n: 12 4 0 li\r\nE\r\n";

fn fit() -> Vec<TimingOperation> {
    vec![
        TimingOperation::SetGap { seconds: 1.25 },
        TimingOperation::SetBpm {
            beats_per_minute: 806.0,
        },
    ]
}

fn phone_id() -> PhoneId {
    PhoneId("4b1d8f0e-0000-4000-8000-000000000223".to_owned())
}

struct Party {
    app: TestApp,
    song: SongId,
    stage: WsClient,
}

/// The next message on `socket`, past change notices.
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

/// Asserts that nothing but change notices arrived before a ping's answer.
async fn heard_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 9 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 9 });
}

impl Party {
    /// One playable Song, a Stage with its Party, and a Phone joined as Bo.
    async fn start() -> Self {
        let mut app = TestApp::builder().start().await;
        let folder = app.songs_dir().join("Placeholder - Fitted");
        std::fs::create_dir(&folder).unwrap();
        openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
        std::fs::write(folder.join("song.txt"), TXT).unwrap();
        app.restart().await;
        let list: SongList = app.get_json("/api/songs").await;
        let song = list.songs[0].id;

        let mut stage = app.connect_stage().await;
        let ServerMessage::LiveState { .. } = recv(&mut stage).await else {
            panic!("the live state first")
        };
        let (party, _) = party_changed(&mut stage).await;
        let code = party.join_code.clone();

        let bo: Profile = app
            .http()
            .post(app.url("/api/profiles"))
            .json(&NewProfile {
                name: "Bo".to_owned(),
                avatar: Avatar::BuiltIn {
                    key: AvatarKey::Star,
                },
                favourite_colour: PaletteKey::Cherry,
            })
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let mut phone = app.connect_ws().await;
        recv(&mut phone).await;
        phone
            .send(&ClientMessage::Join {
                phone_id: phone_id(),
                join_code: code,
                join_as: JoinAs::Profile { profile_id: bo.id },
            })
            .await;
        party_changed(&mut stage).await;
        Self { app, song, stage }
    }

    fn txt(&self) -> std::path::PathBuf {
        self.app.songs_dir().join("Placeholder - Fitted/song.txt")
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
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn base(&self) -> TxtVersion {
        let path = format!("/api/songs/{}/timing/preview", self.song.0);
        let (status, body) = self
            .post(&path, None, Some(json!({ "operations": [] })))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        serde_json::from_value::<TimingPreview>(body).unwrap().base
    }

    async fn save(&self, body: Value) -> (StatusCode, Value) {
        let cookie = self.app.unlock().await;
        let path = format!("/api/songs/{}/timing", self.song.0);
        self.post(&path, Some(&cookie), Some(body)).await
    }
}

#[tokio::test]
async fn starting_a_phones_fit_needs_an_unlock_and_then_asks_for_the_pitch_track() {
    let party = Party::start().await;
    let path = format!("/api/songs/{}/auto-fit", party.song.0);

    let (status, body) = party.post(&path, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "code": "unlockRequired" }));

    let cookie = party.app.unlock().await;
    let (status, body) = party.post(&path, Some(&cookie), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let _: PitchTrackStart = serde_json::from_value(body).unwrap();
    assert_eq!(
        std::fs::read(party.txt()).unwrap(),
        TXT,
        "starting writes nothing"
    );
}

#[tokio::test]
async fn an_accepted_phone_fit_changes_only_gap_and_bpm_and_toasts_on_the_stage() {
    let mut party = Party::start().await;
    let base = party.base().await;

    let (status, body) = party
        .save(json!({ "base": base, "operations": fit(), "autoFitFrom": phone_id() }))
        .await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(std::fs::read(party.txt()).unwrap(), FITTED);
    assert_eq!(
        std::fs::read(party.txt().with_extension("txt.orig")).unwrap(),
        TXT,
        "the Original is kept before the first edit"
    );
    let (snapshot, change) = party_changed(&mut party.stage).await;
    let member_id = snapshot.phones[0].member_id;
    assert_eq!(
        change,
        ChangeEvent {
            actor: Actor::Member { member_id },
            event: PartyEvent::AutoFitAccepted {
                song_id: party.song,
                title: "Fitted".to_owned(),
            },
        }
    );
    heard_nothing(&mut party.stage).await;
}

#[tokio::test]
async fn a_phone_fit_may_change_nothing_but_gap_and_bpm() {
    let mut party = Party::start().await;
    let base = party.base().await;
    let mut operations = fit();
    operations.push(TimingOperation::SetNoteStart { line: 7, start: 5 });

    let (status, body) = party
        .save(json!({ "base": base, "operations": operations, "autoFitFrom": phone_id() }))
        .await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        serde_json::from_value::<UserMessage>(body).unwrap(),
        UserMessage::InvalidMessage
    );
    assert_eq!(std::fs::read(party.txt()).unwrap(), TXT);
    heard_nothing(&mut party.stage).await;
}

#[tokio::test]
async fn a_desktop_save_shows_no_toast() {
    let mut party = Party::start().await;
    let base = party.base().await;

    let (status, body) = party
        .save(json!({ "base": base, "operations": fit() }))
        .await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(std::fs::read(party.txt()).unwrap(), FITTED);
    heard_nothing(&mut party.stage).await;
}
