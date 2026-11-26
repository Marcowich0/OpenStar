//! The guard rule over real HTTP: every endpoint the server mounts is
//! classified guarded or not guarded in `openstar::endpoints`, and these
//! tests walk that classification, so they grow as endpoints are added.

use std::path::Path;

use openstar::endpoints::{Access, Endpoint, Library, ws_access};
use openstar::{Config, Server};
use openstar_protocol::admin::{ApiError, ApiErrorCode, UnlockRequest};
use openstar_protocol::library::SongId;
use openstar_protocol::profile::ProfileId;
use openstar_protocol::{
    ClientMessage, JoinAs, JoinCode, MemberEdit, MicId, PartyMemberId, PhoneId, PitchReading,
    QueueMove, RequestId,
};
use reqwest::StatusCode;

struct App {
    base: String,
    http: reqwest::Client,
    endpoints: Vec<Endpoint>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    served: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl App {
    async fn start(appdata: &Path, songs: &Path) -> Self {
        let config = Config::for_tests(appdata, songs);
        let server = Server::start(&config)
            .await
            .expect("server starts")
            .with_test_routes();
        let endpoints = server.endpoints();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::oneshot::channel();
        let served = tokio::spawn(server.serve_with_shutdown(listener, async {
            let _ = rx.await;
        }));
        Self {
            base,
            http: reqwest::Client::new(),
            endpoints,
            shutdown: Some(tx),
            served,
        }
    }

    async fn stop(mut self) {
        let _ = self.shutdown.take().unwrap().send(());
        self.served.await.unwrap().unwrap();
    }

    /// Calls `endpoint` with every path parameter filled in and no body.
    async fn call(
        &self,
        endpoint: &Endpoint,
        cookie: Option<&str>,
    ) -> (StatusCode, Option<ApiErrorCode>) {
        let path = example_path(endpoint.path);
        let mut request = self
            .http
            .request(endpoint.method.clone(), format!("{}{path}", self.base));
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let body = response.bytes().await.unwrap();
        let code = serde_json::from_slice::<ApiError>(&body)
            .ok()
            .map(|e| e.code);
        (status, code)
    }

    /// Unlocks with the test Admin PIN and returns the cookie pair to send back.
    async fn unlock(&self) -> String {
        let response = self
            .http
            .post(format!("{}/api/unlock", self.base))
            .json(&UnlockRequest {
                pin: "1234".to_owned(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap();
        cookie.split(';').next().unwrap().trim().to_owned()
    }

    fn guarded(&self) -> Vec<&Endpoint> {
        self.endpoints
            .iter()
            .filter(|e| matches!(e.access, Access::Guarded(_)))
            .collect()
    }
}

/// `/api/songs/{id}` → `/api/songs/example`.
fn example_path(path: &str) -> String {
    path.split('/')
        .map(|segment| {
            if segment.starts_with('{') && segment.ends_with('}') {
                "example"
            } else {
                segment
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn describe(endpoint: &Endpoint) -> String {
    format!("{} {}", endpoint.method, endpoint.path)
}

#[tokio::test]
async fn the_classification_lists_guarded_and_not_guarded_endpoints() {
    let appdata = tempfile::tempdir().unwrap();
    let songs = tempfile::tempdir().unwrap();
    let app = App::start(appdata.path(), songs.path()).await;
    let has = |method: &str, path: &str, access: Access| {
        app.endpoints
            .iter()
            .any(|e| e.method.as_str() == method && e.path == path && e.access == access)
    };
    assert!(has("GET", "/api/unlock", Access::NotGuarded));
    assert!(has("POST", "/api/unlock", Access::NotGuarded));
    assert!(has("POST", "/api/lock", Access::NotGuarded));
    assert!(has("GET", "/api/server-info", Access::NotGuarded));
    assert!(has(
        "POST",
        "/api/unlock/heartbeat",
        Access::Guarded(Library::Untouched)
    ));
    assert!(has(
        "POST",
        "/api/test/guarded",
        Access::Guarded(Library::Untouched)
    ));
    assert!(has(
        "POST",
        "/api/test/library-write",
        Access::Guarded(Library::Writes)
    ));
    app.stop().await;
}

#[tokio::test]
async fn every_guarded_endpoint_refuses_without_an_unlock_and_passes_with_one() {
    let appdata = tempfile::tempdir().unwrap();
    let songs = tempfile::tempdir().unwrap();
    let app = App::start(appdata.path(), songs.path()).await;
    let guarded = app.guarded();
    assert!(!guarded.is_empty());
    let cookie = app.unlock().await;
    for endpoint in guarded {
        let (status, code) = app.call(endpoint, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{}", describe(endpoint));
        assert_eq!(
            code,
            Some(ApiErrorCode::UnlockRequired),
            "{}",
            describe(endpoint)
        );

        let (status, code) = app.call(endpoint, Some(&cookie)).await;
        assert_ne!(
            code,
            Some(ApiErrorCode::UnlockRequired),
            "{}",
            describe(endpoint)
        );
        assert_ne!(status, StatusCode::UNAUTHORIZED, "{}", describe(endpoint));
    }
    app.stop().await;
}

#[tokio::test]
async fn every_not_guarded_endpoint_answers_without_an_unlock() {
    let appdata = tempfile::tempdir().unwrap();
    let songs = tempfile::tempdir().unwrap();
    let app = App::start(appdata.path(), songs.path()).await;
    let open: Vec<_> = app
        .endpoints
        .iter()
        .filter(|e| e.access == Access::NotGuarded)
        .collect();
    assert!(!open.is_empty());
    for endpoint in open {
        let (status, code) = app.call(endpoint, None).await;
        assert_ne!(
            code,
            Some(ApiErrorCode::UnlockRequired),
            "{}",
            describe(endpoint)
        );
        assert_ne!(status, StatusCode::UNAUTHORIZED, "{}", describe(endpoint));
    }
    app.stop().await;
}

#[tokio::test]
async fn a_read_only_library_refuses_every_library_write_even_with_an_unlock() {
    let appdata = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    // A missing songs folder makes the Library read-only, also as root.
    let songs = parent.path().join("missing");
    let app = App::start(appdata.path(), &songs).await;
    let cookie = app.unlock().await;
    let guarded = app.guarded();
    assert!(
        guarded
            .iter()
            .any(|e| e.access == Access::Guarded(Library::Writes))
    );
    for endpoint in guarded {
        let (status, code) = app.call(endpoint, Some(&cookie)).await;
        match endpoint.access {
            Access::Guarded(Library::Writes) => {
                assert_eq!(status, StatusCode::CONFLICT, "{}", describe(endpoint));
                assert_eq!(
                    code,
                    Some(ApiErrorCode::LibraryReadOnly),
                    "{}",
                    describe(endpoint)
                );
                let (_, code) = app.call(endpoint, None).await;
                assert_eq!(
                    code,
                    Some(ApiErrorCode::LibraryReadOnly),
                    "{}",
                    describe(endpoint)
                );
            }
            _ => {
                assert_ne!(
                    code,
                    Some(ApiErrorCode::LibraryReadOnly),
                    "{}",
                    describe(endpoint)
                );
                assert_ne!(
                    code,
                    Some(ApiErrorCode::UnlockRequired),
                    "{}",
                    describe(endpoint)
                );
            }
        }
    }
    app.stop().await;
}

#[tokio::test]
async fn a_writable_library_lets_an_unlocked_library_write_through() {
    let appdata = tempfile::tempdir().unwrap();
    let songs = tempfile::tempdir().unwrap();
    let app = App::start(appdata.path(), songs.path()).await;
    let cookie = app.unlock().await;
    let write = Endpoint {
        method: reqwest::Method::POST,
        path: "/api/test/library-write",
        access: Access::Guarded(Library::Writes),
    };
    assert_eq!(
        app.call(&write, Some(&cookie)).await,
        (StatusCode::NO_CONTENT, None)
    );
    app.stop().await;
}

/// Every WebSocket client message, one sample per variant. The completeness
/// check below fails when a variant is added without a sample here.
fn every_client_message() -> Vec<ClientMessage> {
    vec![
        ClientMessage::Ping { nonce: 0 },
        ClientMessage::NewParty,
        ClientMessage::PitchReading {
            reading: PitchReading {
                capture_ms: 0.0,
                pitch: None,
                clarity: 0.0,
                loudness: -120.0,
            },
            input: None,
        },
        ClientMessage::ClockPing {
            t0: 0.0,
            input: None,
        },
        ClientMessage::ClockPong {
            mic: MicId::Phone {
                phone_id: PhoneId("phone".into()),
            },
            t0: 0.0,
            ts: 0.0,
            epoch: 0.0,
        },
        ClientMessage::MicPage { visible: false },
        ClientMessage::StoreCalibration {
            stage_output: String::new(),
            results: Vec::new(),
        },
        ClientMessage::SetMicThreshold {
            stage_output: String::new(),
            local_mic_id: String::new(),
            reference_dbfs: -40.0,
        },
        ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: String::new(),
            source: openstar_protocol::mics::LocalMicSource::Browser {
                stage_browser: String::new(),
                device_id: String::new(),
                label: String::new(),
                channel: 0,
                stereo: false,
            },
            switched_on: false,
        },
        ClientMessage::SetLocalMicName {
            local_mic_id: String::new(),
            source: openstar_protocol::mics::LocalMicSource::Browser {
                stage_browser: String::new(),
                device_id: String::new(),
                label: String::new(),
                channel: 0,
                stereo: false,
            },
            name: String::new(),
        },
        ClientMessage::RelinkLocalMic {
            local_mic_id: String::new(),
            new_local_mic_id: String::new(),
            source: openstar_protocol::mics::LocalMicSource::Browser {
                stage_browser: String::new(),
                device_id: String::new(),
                label: String::new(),
                channel: 0,
                stereo: false,
            },
        },
        ClientMessage::Hello {
            phone_id: PhoneId("phone".to_owned()),
        },
        ClientMessage::CheckJoinCode {
            join_code: JoinCode("0000".to_owned()),
        },
        ClientMessage::Join {
            phone_id: PhoneId("phone".to_owned()),
            join_code: JoinCode("0000".to_owned()),
            join_as: JoinAs::Profile {
                profile_id: ProfileId(1),
            },
        },
        ClientMessage::SwitchIdentity {
            join_as: JoinAs::Profile {
                profile_id: ProfileId(1),
            },
        },
        ClientMessage::EditMember {
            member_id: PartyMemberId(1),
            edit: MemberEdit::default(),
        },
        ClientMessage::AddRequest {
            song_id: SongId(1),
            requested_players: None,
        },
        ClientMessage::MoveRequest {
            request_id: RequestId(1),
            to: QueueMove::Next,
        },
        ClientMessage::SetRequestedPlayers {
            request_id: RequestId(1),
            requested_players: vec![PartyMemberId(1)],
        },
        ClientMessage::RemoveRequest {
            request_id: RequestId(1),
        },
        ClientMessage::ReportMicBlocked { blocked: true },
        ClientMessage::ReportStageOutput {
            stage_browser: String::new(),
            stage_output: String::new(),
        },
        ClientMessage::StepVolume {
            step: openstar_protocol::volume::VolumeStep::Up,
        },
        ClientMessage::StartAvSync,
        ClientMessage::StepAvSync {
            step: openstar_protocol::av_offset::AvSyncStep::Up,
        },
        ClientMessage::EndAvSync,
        ClientMessage::OpenCalibration,
        ClientMessage::ChooseCalibrationMic {
            mic: openstar_protocol::mics::MicKey::Phone {
                phone_id: "4b1d8f0e-0000-4000-8000-000000000001".into(),
            },
            chosen: true,
        },
        ClientMessage::StartCalibration,
        ClientMessage::CalibrationListening,
        ClientMessage::CalibrationGo,
        ClientMessage::FinishCalibration { results: vec![] },
        ClientMessage::EndCalibration,
        ClientMessage::LeaveParty,
        ClientMessage::RemoveMember {
            member_id: PartyMemberId(1),
        },
        ClientMessage::EditLineUp {
            request_id: openstar_protocol::RequestId(1),
            edit: openstar_protocol::LineUpEdit::RemoveSeat { seat: 0 },
        },
        ClientMessage::SetMyDifficulty {
            difficulty: openstar_protocol::profile::Difficulty::Hard,
        },
        ClientMessage::ControlSong {
            request_id: openstar_protocol::RequestId(1),
            control: openstar_protocol::SongControl::Skip,
        },
        ClientMessage::CloseResults,
        ClientMessage::ReportSongPosition {
            request_id: openstar_protocol::RequestId(1),
            position_seconds: 0.0,
            rate: 1.0,
            length_seconds: None,
        },
        ClientMessage::ReportLineScore {
            request_id: openstar_protocol::RequestId(1),
            seat: 0,
            total: 0,
        },
        ClientMessage::BridgeHello {
            build: "dev".into(),
            host_name: "hermes".into(),
            token: None,
            interfaces: vec![],
        },
        ClientMessage::ApproveBridge {
            request_id: openstar_protocol::bridge::BridgeRequestId(0),
        },
        ClientMessage::SetMicsScreenOpen { open: true },
        ClientMessage::ReportPresentLocalMics {
            local_mic_ids: vec!["browser:stage:device:0".into()],
        },
        ClientMessage::BridgeLevels { levels: vec![] },
    ]
}

#[test]
fn no_websocket_client_message_is_a_guarded_action() {
    for message in every_client_message() {
        assert_eq!(ws_access(&message), Access::NotGuarded, "{message:?}");
    }
}

#[test]
fn the_websocket_samples_cover_every_client_message_type() {
    let generated = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/generated/ClientMessage.ts"),
    )
    .unwrap();
    let mut declared: Vec<String> = generated
        .split("\"type\": \"")
        .skip(1)
        .map(|rest| rest.split('"').next().unwrap().to_owned())
        .collect();
    declared.sort();
    let mut sampled: Vec<String> = every_client_message()
        .iter()
        .map(|m| {
            serde_json::to_value(m).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    sampled.sort();
    assert!(!declared.is_empty());
    assert_eq!(sampled, declared);
}
