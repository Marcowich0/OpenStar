//! The guard rule over real HTTP: every endpoint the server mounts is
//! classified guarded or not guarded in `openstar::endpoints`, and these
//! tests walk that classification, so they grow as endpoints are added.

use std::path::Path;

use openstar::endpoints::{Access, Endpoint, Library, ws_access};
use openstar::{Config, Server};
use openstar_protocol::UserMessage;
use openstar_protocol::admin::UnlockRequest;
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
    ) -> (StatusCode, Option<UserMessage>) {
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
        let code = serde_json::from_slice::<UserMessage>(&body).ok();
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
            Some(UserMessage::UnlockRequired),
            "{}",
            describe(endpoint)
        );

        let (status, code) = app.call(endpoint, Some(&cookie)).await;
        assert_ne!(
            code,
            Some(UserMessage::UnlockRequired),
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
            Some(UserMessage::UnlockRequired),
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
                    Some(UserMessage::LibraryReadOnly),
                    "{}",
                    describe(endpoint)
                );
                let (_, code) = app.call(endpoint, None).await;
                assert_eq!(
                    code,
                    Some(UserMessage::LibraryReadOnly),
                    "{}",
                    describe(endpoint)
                );
            }
            _ => {
                assert_ne!(
                    code,
                    Some(UserMessage::LibraryReadOnly),
                    "{}",
                    describe(endpoint)
                );
                assert_ne!(
                    code,
                    Some(UserMessage::UnlockRequired),
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
            local_mic: None,
        },
        ClientMessage::ClockPing {
            t0: 0.0,
            local_mic: None,
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
        ClientMessage::MicReportRequest,
        ClientMessage::MicReport {
            mic: MicId::Phone {
                phone_id: PhoneId("phone".into()),
            },
            report: openstar_protocol::pitch::StageMicReport {
                received_per_second: 0,
                arrival_p50_ms: None,
                arrival_p95_ms: None,
                arrival_max_ms: None,
                largest_gap_ms: None,
                late_share: None,
                loudness_dbfs: None,
                mic_delay_ms: 100.0,
                mic_threshold_dbfs: -30.0,
            },
        },
        ClientMessage::SetPhoneMicThreshold {
            stage_output: String::new(),
            phone_id: PhoneId("phone".into()),
            reference_dbfs: -30.0,
        },
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
        ClientMessage::ReportAvSyncOffset { av_offset_ms: 120 },
        ClientMessage::OpenCalibration,
        ClientMessage::OpenCalibrationFor {
            mic: openstar_protocol::mics::MicKey::Phone {
                phone_id: "4b1d8f0e-0000-4000-8000-000000000001".into(),
            },
        },
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
        ClientMessage::CalibrateLocalMicNow {
            local_mic_id: "browser:stage:device:0".into(),
        },
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
        ClientMessage::ReportSilentLocalMics {
            local_mic_ids: vec!["browser:stage:device:0".into()],
        },
        ClientMessage::ReportCapturingLocalMics {
            local_mic_ids: vec!["browser:stage:device:0".into()],
        },
        ClientMessage::BridgeLevels { levels: vec![] },
        ClientMessage::BridgeInputDelays { delays: vec![] },
        ClientMessage::BridgeInterfaces {
            interfaces: vec![],
            not_pro_audio: vec![],
        },
        ClientMessage::SwitchBridgeToProAudio {
            bridge_id: openstar_protocol::bridge::BridgeId("b".into()),
            device_name: "alsa_card.usb-X-00".into(),
        },
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

// ---------------------------------------------------------------------------
// The guard audit (#224): the complete v1 list of guarded and not-guarded
// actions from the area spec #45, pinned as one table. Each action names the
// endpoints or WebSocket messages it is made of and the tests that check it
// for real (refused without an Unlock, done with one, refused while it plays
// or sings; or done with no Unlock and no Stage trust). The tests below fail
// when an action has no endpoint, when its endpoint is classified otherwise
// in `openstar::endpoints`, when an endpoint or a client message belongs to
// no action, or when a cited test is gone.
// ---------------------------------------------------------------------------

/// What the rule says an action needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Needs {
    /// An Unlock: the endpoint is guarded in `endpoints.rs`.
    Unlock(Library),
    /// Nothing: whatever the browser, no Unlock and no Stage trust.
    Nothing,
    /// The Admin PIN once per browser (Stage trust), checked by the handler,
    /// so the endpoints are `NotGuarded` in `endpoints.rs`.
    StageTrust,
}

/// One way an action reaches the server.
#[derive(Debug, Clone, Copy)]
enum Via {
    /// An HTTP endpoint, as `endpoints.rs` mounts it.
    Http(&'static str, &'static str),
    /// A WebSocket client message, by its `type` tag.
    Ws(&'static str),
    /// Only the frontend: a page or a change that sends no request.
    Frontend,
}

/// A test that checks the action for real: `file` (from the repo root)
/// contains `test`, the test's function name or its title.
type Proof = (&'static str, &'static str);

struct Action {
    name: &'static str,
    needs: Needs,
    via: &'static [Via],
    proofs: &'static [Proof],
}

const SERVER: &str = "crates/server/tests/";

/// The complete v1 list (area spec #45, "What the Admin PIN guards").
const V1_ACTIONS: &[Action] = {
    use Library::{Untouched, Writes};
    use Needs::{Nothing, StageTrust, Unlock};
    use Via::{Frontend, Http, Ws};
    &[
        // ---- Guarded ----
        Action {
            name: "Starting a Download",
            needs: Unlock(Writes),
            via: &[Http("POST", "/api/downloads")],
            proofs: &[
                (
                    "usdb_downloads.rs",
                    "starting_a_download_needs_an_unlock_but_the_picker_does_not",
                ),
                (
                    "usdb_downloads.rs",
                    "a_download_writes_the_song_into_the_library_and_records_its_version",
                ),
                (
                    "usdb_downloads.rs",
                    "a_read_only_library_refuses_a_download_even_with_an_unlock",
                ),
            ],
        },
        Action {
            name: "Saving a Timing edit in the desktop Timing editor",
            needs: Unlock(Writes),
            via: &[Http("POST", "/api/songs/{id}/timing")],
            proofs: &[
                ("timing_save.rs", "saving_and_restoring_need_an_unlock"),
                (
                    "timing_save.rs",
                    "a_save_keeps_the_original_once_and_changes_only_the_touched_lines",
                ),
                (
                    "timing_save.rs",
                    "the_song_playing_now_cannot_be_saved_or_restored",
                ),
            ],
        },
        Action {
            name: "Running \"Fit to the singing\" on a Phone, and accepting its proposal",
            needs: Unlock(Writes),
            via: &[
                Http("POST", "/api/songs/{id}/auto-fit"),
                Http("POST", "/api/songs/{id}/timing"),
            ],
            proofs: &[
                (
                    "auto_fit_phone.rs",
                    "starting_a_phones_fit_needs_an_unlock_and_then_asks_for_the_pitch_track",
                ),
                (
                    "auto_fit_phone.rs",
                    "an_accepted_phone_fit_changes_only_gap_and_bpm_and_toasts_on_the_stage",
                ),
            ],
        },
        Action {
            name: "Restore Original; refused while the Song plays",
            needs: Unlock(Writes),
            via: &[Http("POST", "/api/songs/{id}/restore-original")],
            proofs: &[
                ("timing_save.rs", "saving_and_restoring_need_an_unlock"),
                (
                    "timing_save.rs",
                    "restore_original_puts_the_original_back_and_removes_it",
                ),
                (
                    "timing_save.rs",
                    "the_song_playing_now_cannot_be_saved_or_restored",
                ),
            ],
        },
        Action {
            name: "Deleting a Song (to the 30-day trash); refused while it plays",
            needs: Unlock(Writes),
            via: &[Http("DELETE", "/api/songs/{id}")],
            proofs: &[
                ("song_delete.rs", "the_delete_needs_an_unlock"),
                (
                    "song_delete.rs",
                    "a_deleted_song_moves_whole_to_the_trash_and_leaves_the_index",
                ),
                (
                    "song_delete.rs",
                    "a_delete_is_refused_while_the_song_plays_and_moves_nothing",
                ),
                (
                    "web/src/admin/Songs.test.tsx",
                    "does nothing on a short press",
                ),
            ],
        },
        Action {
            name: "Restoring a Song from the trash",
            needs: Unlock(Writes),
            via: &[Http("POST", "/api/library/trash/{id}/restore")],
            proofs: &[
                (
                    "song_restore.rs",
                    "a_restore_needs_an_unlock_and_moves_nothing_without_one",
                ),
                (
                    "song_restore.rs",
                    "a_restored_song_is_back_at_its_original_path_in_the_index_with_its_records",
                ),
                (
                    "web/src/admin/Trash.test.tsx",
                    "does nothing on a short press",
                ),
            ],
        },
        Action {
            name: "Deleting a Profile and its Score records; refused while it sings",
            needs: Unlock(Untouched),
            via: &[Http("DELETE", "/api/profiles/{id}")],
            proofs: &[
                (
                    "deletions.rs",
                    "deleting_a_profile_is_refused_without_an_unlock_and_the_profile_stays",
                ),
                (
                    "scores.rs",
                    "deleting_a_profile_deletes_its_records_and_renaming_keeps_them",
                ),
                (
                    "deletions.rs",
                    "deleting_a_profile_is_refused_while_it_sings_in_the_playing_song",
                ),
                (
                    "web/src/admin/Profiles.test.tsx",
                    "does nothing on a short press of Delete",
                ),
            ],
        },
        Action {
            name: "Forget a Mic bridge",
            needs: Unlock(Untouched),
            via: &[Http("DELETE", "/api/mic-bridges/{id}")],
            proofs: &[
                (
                    "forget_bridge.rs",
                    "forget_without_an_unlock_is_refused_and_the_bridge_stays_approved",
                ),
                (
                    "forget_bridge.rs",
                    "forget_with_an_unlock_removes_the_approval_and_every_value_of_its_local_mics",
                ),
                (
                    "web/src/mics/ForgetBridge.test.tsx",
                    "does nothing on a short press",
                ),
            ],
        },
        Action {
            name: "Keeping an Unlock alive (the heartbeat; changes nothing, needs a live Unlock)",
            needs: Unlock(Untouched),
            via: &[Http("POST", "/api/unlock/heartbeat")],
            proofs: &[
                ("unlock.rs", "a_heartbeat_resets_the_idle_time"),
                (
                    "unlock.rs",
                    "a_heartbeat_never_creates_or_revives_an_unlock",
                ),
            ],
        },
        Action {
            name: "Becoming the Stage: the first Stage, taking over, \"Make this the Stage again\"",
            needs: StageTrust,
            via: &[Http("POST", "/api/stage/trust"), Http("GET", "/ws/stage")],
            proofs: &[
                (
                    "stage_trust.rs",
                    "a_browser_that_is_not_remembered_cannot_become_the_stage_without_the_pin",
                ),
                (
                    "stage_trust.rs",
                    "with_a_correct_pin_the_browser_becomes_the_stage_and_is_remembered",
                ),
                (
                    "stage_trust.rs",
                    "a_browser_that_holds_an_unlock_still_needs_the_pin_to_become_the_stage",
                ),
            ],
        },
        // ---- Not guarded ----
        Action {
            name: "Opening the Admin area and looking at any section",
            needs: Nothing,
            via: &[
                Frontend,
                Http("GET", "/healthz"),
                Http("GET", "/api/server-info"),
                Http("GET", "/api/songs"),
                Http("GET", "/api/songs/{id}"),
                Http("GET", "/api/songs/{id}/media/{role}"),
                Http("GET", "/api/songs/{id}/high-scores"),
                Http("GET", "/api/library/trash"),
                Http("GET", "/api/profiles"),
                Http("GET", "/api/profiles/{id}"),
            ],
            proofs: &[(
                "web/src/admin/AdminArea.test.tsx",
                "opens without a PIN and links to its four sections",
            )],
        },
        Action {
            name: "Rescan and the Library problems list",
            needs: Nothing,
            via: &[
                Http("POST", "/api/library/rescan"),
                Http("GET", "/api/library/scan"),
                Http("GET", "/api/library/problems"),
            ],
            proofs: &[
                (
                    "library_scan.rs",
                    "rescan_needs_no_pin_and_reports_the_scan_state",
                ),
                (
                    "library_scan.rs",
                    "rejections_and_warnings_are_listed_as_library_problems",
                ),
            ],
        },
        Action {
            name: "Browsing and searching USDB, and seeing the video candidates",
            needs: Nothing,
            via: &[
                Http("GET", "/api/usdb/status"),
                Http("GET", "/api/usdb/mirror"),
                Http("POST", "/api/usdb/mirror/refresh"),
                Http("GET", "/api/usdb/songs"),
                Http("GET", "/api/usdb/songs/{id}/cover"),
                Http("GET", "/api/usdb/songs/{id}/videos"),
                Http("GET", "/api/usdb/video-details"),
                Http("GET", "/api/usdb/songs/{id}/version"),
            ],
            proofs: &[(
                "usdb_downloads.rs",
                "starting_a_download_needs_an_unlock_but_the_picker_does_not",
            )],
        },
        Action {
            name: "A full USDB refetch started by hand",
            needs: Nothing,
            via: &[Http("POST", "/api/usdb/mirror/refetch")],
            proofs: &[(
                "usdb_mirror.rs",
                "a_full_refetch_by_hand_needs_no_pin_and_drops_songs_usdb_no_longer_has",
            )],
        },
        Action {
            name: "Cancelling a Download",
            needs: Nothing,
            via: &[Http("POST", "/api/downloads/{id}/cancel")],
            proofs: &[(
                "usdb_downloads.rs",
                "cancelling_needs_no_pin_stops_yt_dlp_and_removes_only_the_temporary_folder",
            )],
        },
        Action {
            name: "Opening the desktop Timing editor, computing a Pitch track, working up to saving",
            needs: Nothing,
            via: &[
                Http("POST", "/api/songs/{id}/pitch-track"),
                Http("GET", "/api/songs/{id}/pitch-track"),
                Http("POST", "/api/songs/{id}/timing/preview"),
                Http("GET", "/api/library/originals"),
                Http("GET", "/api/jobs"),
            ],
            proofs: &[
                (
                    "pitch_track.rs",
                    "the_track_is_voiced_on_the_notes_cached_and_recomputed_when_its_key_changes",
                ),
                (
                    "timing_save.rs",
                    "the_preview_lists_exactly_the_lines_that_change",
                ),
            ],
        },
        Action {
            name: "Undo of a Phone's fit proposal (writes nothing)",
            needs: Nothing,
            via: &[Frontend],
            proofs: &[(
                "web/src/admin/timing/PhoneAutoFit.test.tsx",
                "Undo drops the proposal and writes nothing",
            )],
        },
        Action {
            name: "Creating and editing Profiles",
            needs: Nothing,
            via: &[
                Http("POST", "/api/profiles"),
                Http("PATCH", "/api/profiles/{id}"),
            ],
            proofs: &[
                (
                    "profiles.rs",
                    "creating_a_profile_stores_it_with_medium_and_no_last_sung",
                ),
                (
                    "profiles.rs",
                    "anyone_may_edit_any_profiles_name_avatar_and_colour",
                ),
            ],
        },
        Action {
            name: "Looking at a Profile's stats",
            needs: Nothing,
            via: &[Http("GET", "/api/profiles/{id}/stats")],
            proofs: &[
                (
                    "profile_stats.rs",
                    "known_rounds_over_two_difficulties_give_the_expected_stats_without_guests",
                ),
                ("profile_stats.rs", "an_unknown_profile_has_no_stats"),
            ],
        },
        Action {
            name: "Checking a Join code, joining, rejoining, switching who a Phone is, editing a member",
            needs: Nothing,
            via: &[
                Http("GET", "/ws"),
                Ws("hello"),
                Ws("checkJoinCode"),
                Ws("join"),
                Ws("switchIdentity"),
                Ws("editMember"),
            ],
            proofs: &[
                (
                    "phones.rs",
                    "joining_needs_the_right_code_and_an_existing_profile",
                ),
                (
                    "guests.rs",
                    "switching_identity_changes_only_this_phone_and_the_previous_member_stays",
                ),
            ],
        },
        Action {
            name: "Removing a Party member and Leave party",
            needs: Nothing,
            via: &[Ws("removeMember"), Ws("leaveParty")],
            proofs: &[
                (
                    "leaving.rs",
                    "a_removed_phone_is_out_and_needs_the_code_to_come_back",
                ),
                (
                    "leaving.rs",
                    "a_guest_who_leaves_is_gone_and_its_colour_and_name_are_free_again",
                ),
            ],
        },
        Action {
            name: "New party",
            needs: Nothing,
            via: &[Ws("newParty")],
            proofs: &[(
                "party.rs",
                "new_party_from_the_stage_issues_a_new_join_code_to_everyone_without_a_pin",
            )],
        },
        Action {
            name: "Every Queue, Line-up and playback action, including Restart, Skip and End",
            needs: Nothing,
            via: &[
                Ws("addRequest"),
                Ws("moveRequest"),
                Ws("setRequestedPlayers"),
                Ws("removeRequest"),
                Ws("editLineUp"),
                Ws("setMyDifficulty"),
                Ws("controlSong"),
                Ws("closeResults"),
                Http("POST", "/api/rounds"),
            ],
            proofs: &[
                (
                    "queue.rs",
                    "anyone_changes_requested_players_and_removes_any_request_the_head_included",
                ),
                (
                    "line_up_editing.rs",
                    "anyone_edits_the_waiting_line_up_and_start_is_rechecked_after_every_edit",
                ),
                (
                    "play.rs",
                    "pause_resume_and_restart_come_from_any_remote_and_reach_the_stage",
                ),
                (
                    "play.rs",
                    "skip_removes_the_request_without_results_and_brings_up_the_next_line_up",
                ),
                (
                    "play.rs",
                    "end_shows_results_until_next_brings_up_the_next_line_up",
                ),
            ],
        },
        Action {
            name: "Calibrate mics and \"Calibrate this mic now\"",
            needs: Nothing,
            via: &[
                Ws("openCalibration"),
                Ws("openCalibrationFor"),
                Ws("chooseCalibrationMic"),
                Ws("startCalibration"),
                Ws("calibrationListening"),
                Ws("calibrationGo"),
                Ws("finishCalibration"),
                Ws("endCalibration"),
                Ws("calibrateLocalMicNow"),
                Ws("storeCalibration"),
                Http("GET", "/api/mic-settings"),
            ],
            proofs: &[
                (
                    "calibration.rs",
                    "a_remote_starts_ticks_and_goes_in_the_one_run_the_stage_shows",
                ),
                (
                    "calibration_local_mics.rs",
                    "calibrate_this_mic_now_runs_that_local_mic_alone_and_later_runs_start_it_unticked",
                ),
                (
                    "mic_settings.rs",
                    "only_the_active_stage_may_write_and_no_admin_pin_is_needed",
                ),
            ],
        },
        Action {
            name: "Check A/V sync, and a browser's own A/V offset",
            needs: Nothing,
            via: &[
                Ws("startAvSync"),
                Ws("stepAvSync"),
                Ws("endAvSync"),
                Ws("reportAvSyncOffset"),
                Http("GET", "/api/av-offset"),
                Http("PUT", "/api/av-offset"),
            ],
            proofs: &[
                (
                    "av_sync.rs",
                    "a_remote_starts_steps_and_ends_it_and_every_browser_hears_while_it_runs",
                ),
                (
                    "av_sync.rs",
                    "the_stage_starts_it_with_no_pin_and_a_stranger_cannot",
                ),
                (
                    "av_offset.rs",
                    "each_browser_and_output_keeps_its_own_value_across_a_restart",
                ),
            ],
        },
        Action {
            name: "Setting the OpenStar volume, from the Stage or a Remote",
            needs: Nothing,
            via: &[Ws("stepVolume"), Ws("reportStageOutput")],
            proofs: &[(
                "stage_outputs.rs",
                "a_joined_remote_steps_the_volume_with_no_pin_and_every_browser_hears_it",
            )],
        },
        Action {
            name: "Reading and setting the Stage options (Setup › Options)",
            needs: Nothing,
            via: &[
                Http("GET", "/api/stage-options"),
                Http("PUT", "/api/stage-options"),
            ],
            proofs: &[(
                "stage_options.rs",
                "anyone_sets_them_and_they_survive_a_restart",
            )],
        },
        Action {
            name: "Hiding the join card",
            needs: Nothing,
            via: &[Frontend],
            proofs: &[(
                "web/src/stage/joinCard/JoinCard.test.tsx",
                "hides to a Join chip and opens again, remembered in the browser's storage",
            )],
        },
        Action {
            name: "A Phone's Mic threshold by hand, from that Phone or a Line-up seat",
            needs: Nothing,
            via: &[Ws("setPhoneMicThreshold")],
            proofs: &[
                (
                    "phone_mic_diagnostics.rs",
                    "a_phone_sets_its_own_mic_threshold_without_a_pin",
                ),
                (
                    "phone_mic_diagnostics.rs",
                    "the_stage_sets_any_phones_mic_threshold",
                ),
            ],
        },
        Action {
            name: "On the Mics screen: Local mics on and off, renaming one, Find it, a Mic threshold",
            needs: Nothing,
            via: &[
                Http("GET", "/api/local-mics"),
                Ws("setLocalMicSwitchedOn"),
                Ws("setLocalMicName"),
                Ws("relinkLocalMic"),
                Ws("setMicThreshold"),
                Ws("setMicsScreenOpen"),
            ],
            proofs: &[
                (
                    "forget_bridge.rs",
                    "approving_switching_renaming_and_thresholds_stay_pin_free",
                ),
                (
                    "local_mics.rs",
                    "find_it_moves_the_name_the_switch_and_every_mic_setting_to_the_new_channel",
                ),
                (
                    "web/src/mics/MicsScreen.test.tsx",
                    "switches a channel on with no Admin PIN",
                ),
            ],
        },
        Action {
            name: "Add a Mic bridge, the /bridge page and its download",
            needs: Nothing,
            via: &[
                Frontend,
                Http("GET", "/bridge/{file}"),
                Http("GET", "/ws/bridge"),
                Ws("bridgeHello"),
                Http("GET", "/api/mic-bridges"),
            ],
            proofs: &[
                (
                    "bridge_files.rs",
                    "the_binary_and_its_checksum_are_served_without_a_pin_and_match",
                ),
                (
                    "web/src/bridge/BridgeScreen.test.tsx",
                    "shows the install command and a direct download, with no PIN",
                ),
                (
                    "web/src/mics/MicsScreen.test.tsx",
                    "offers Add a Mic bridge after the groups",
                ),
            ],
        },
        Action {
            name: "Approving a new Mic bridge from the active Stage browser",
            needs: Nothing,
            via: &[Ws("approveBridge")],
            proofs: &[
                (
                    "mic_bridge.rs",
                    "a_new_bridge_waits_with_a_code_the_stage_sees_and_approves_without_a_pin",
                ),
                ("mic_bridge.rs", "only_the_stage_may_approve_a_bridge"),
            ],
        },
        Action {
            name: "Switch to Pro Audio for a Mic bridge's interface",
            needs: Nothing,
            via: &[Ws("bridgeInterfaces"), Ws("switchBridgeToProAudio")],
            proofs: &[(
                "bridge_profile.rs",
                "switch_to_pro_audio_on_the_stage_reaches_the_bridge",
            )],
        },
        Action {
            name: "Lock, the Unlock status and the PIN attempt itself",
            needs: Nothing,
            via: &[
                Http("POST", "/api/lock"),
                Http("GET", "/api/unlock"),
                Http("POST", "/api/unlock"),
            ],
            proofs: &[
                ("unlock.rs", "lock_needs_no_unlock"),
                (
                    "unlock.rs",
                    "a_correct_pin_sets_an_http_only_same_site_strict_cookie_and_unlocks",
                ),
            ],
        },
        Action {
            name: "What Mics, the Stage and bridges report: readings, clock sync, levels, position",
            needs: Nothing,
            via: &[
                Ws("ping"),
                Ws("pitchReading"),
                Ws("clockPing"),
                Ws("clockPong"),
                Ws("micPage"),
                Ws("micReportRequest"),
                Ws("micReport"),
                Ws("reportMicBlocked"),
                Ws("reportSongPosition"),
                Ws("reportLineScore"),
                Ws("reportPresentLocalMics"),
                Ws("reportCapturingLocalMics"),
                Ws("reportSilentLocalMics"),
                Ws("bridgeLevels"),
                Ws("bridgeInputDelays"),
            ],
            proofs: &[
                (
                    "relay.rs",
                    "a_ping_reaches_the_stage_and_its_pong_goes_back_to_the_phone_that_pinged_alone",
                ),
                (
                    "phone_mic_diagnostics.rs",
                    "a_phones_report_request_reaches_the_stage_and_the_answer_only_that_phone",
                ),
                (
                    "unlock.rs",
                    "no_websocket_message_unlocks_locks_or_performs_a_guarded_action",
                ),
            ],
        },
    ]
};

/// Whether `endpoint` exists only on `Server::with_test_routes`.
fn test_only(endpoint: &Endpoint) -> bool {
    endpoint.path.starts_with("/api/test/")
}

fn real_endpoints() -> Vec<Endpoint> {
    let appdata = tempfile::tempdir().unwrap();
    let songs = tempfile::tempdir().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let endpoints = runtime.block_on(async {
        let config = Config::for_tests(appdata.path(), songs.path());
        Server::start(&config).await.unwrap().endpoints()
    });
    endpoints.into_iter().filter(|e| !test_only(e)).collect()
}

fn client_message_tag(message: &ClientMessage) -> String {
    serde_json::to_value(message).unwrap()["type"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn every_action_on_the_v1_list_has_its_endpoint_classified_the_same_way() {
    let endpoints = real_endpoints();
    let samples = every_client_message();
    let mut wrong = Vec::new();
    for action in V1_ACTIONS {
        assert!(!action.via.is_empty(), "{}: names no way in", action.name);
        let http = action
            .via
            .iter()
            .filter(|v| matches!(v, Via::Http(..)))
            .count();
        if action.needs != Needs::Nothing && http == 0 {
            wrong.push(format!("{}: a guarded action has no endpoint", action.name));
        }
        for via in action.via {
            match *via {
                Via::Http(method, path) => {
                    let expected = match action.needs {
                        Needs::Unlock(library) => Access::Guarded(library),
                        Needs::Nothing | Needs::StageTrust => Access::NotGuarded,
                    };
                    match endpoints
                        .iter()
                        .find(|e| e.method.as_str() == method && e.path == path)
                    {
                        None => {
                            wrong.push(format!("{}: {method} {path} is not mounted", action.name))
                        }
                        Some(e) if e.access != expected => wrong.push(format!(
                            "{}: {method} {path} is {:?}, the rule says {expected:?}",
                            action.name, e.access
                        )),
                        Some(_) => {}
                    }
                }
                Via::Ws(tag) => {
                    if action.needs != Needs::Nothing {
                        wrong.push(format!(
                            "{}: the WebSocket carries no guarded action, but {tag} is listed",
                            action.name
                        ));
                    }
                    match samples.iter().find(|m| client_message_tag(m) == tag) {
                        None => wrong.push(format!("{}: no client message {tag}", action.name)),
                        Some(m) if ws_access(m) != Access::NotGuarded => {
                            wrong.push(format!("{}: {tag} is guarded", action.name));
                        }
                        Some(_) => {}
                    }
                }
                Via::Frontend => {}
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn every_endpoint_and_client_message_belongs_to_an_action_on_the_v1_list() {
    let listed_http: Vec<(&str, &str)> = V1_ACTIONS
        .iter()
        .flat_map(|a| a.via)
        .filter_map(|v| match *v {
            Via::Http(method, path) => Some((method, path)),
            _ => None,
        })
        .collect();
    let listed_ws: Vec<&str> = V1_ACTIONS
        .iter()
        .flat_map(|a| a.via)
        .filter_map(|v| match *v {
            Via::Ws(tag) => Some(tag),
            _ => None,
        })
        .collect();
    let mut missing: Vec<String> = real_endpoints()
        .iter()
        .filter(|e| !listed_http.contains(&(e.method.as_str(), e.path)))
        .map(describe)
        .collect();
    missing.extend(
        every_client_message()
            .iter()
            .map(client_message_tag)
            .filter(|tag| !listed_ws.contains(&tag.as_str())),
    );
    assert!(
        missing.is_empty(),
        "classify these by the rule and add them to V1_ACTIONS (and docs/agents/guard-rule.md):\n{}",
        missing.join("\n")
    );
}

#[test]
fn every_action_on_the_v1_list_cites_tests_that_exist() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut gone = Vec::new();
    for action in V1_ACTIONS {
        assert!(!action.proofs.is_empty(), "{}: cites no test", action.name);
        for &(file, test) in action.proofs {
            let path = if file.contains('/') {
                root.join(file)
            } else {
                root.join(SERVER).join(file)
            };
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let found = if file.ends_with(".rs") {
                text.contains(&format!("async fn {test}()"))
                    || text.contains(&format!("fn {test}()"))
            } else {
                text.contains(&format!("it(\"{test}\""))
            };
            if !found {
                gone.push(format!("{}: {file} has no test {test:?}", action.name));
            }
        }
    }
    assert!(gone.is_empty(), "{}", gone.join("\n"));
}

/// `web/src/guardAudit.test.ts` keeps its own list of the guarded endpoints
/// (it checks none is reachable from the Remote's tabs or the Stage's
/// overlays); it must be exactly the server's.
#[test]
fn the_frontends_list_of_guarded_endpoints_is_the_servers() {
    let text = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/guardAudit.test.ts"),
    )
    .unwrap();
    let list = text
        .split("const GUARDED = [")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .expect("guardAudit.test.ts has `const GUARDED = [ ... ]`");
    let mut frontend: Vec<String> = list
        .split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect();
    frontend.sort();
    let mut server: Vec<String> = real_endpoints()
        .iter()
        .filter(|e| matches!(e.access, Access::Guarded(_)))
        .map(describe)
        .collect();
    server.sort();
    assert_eq!(frontend, server);
}
