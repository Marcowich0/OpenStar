//! The Stage options (Setup › Options) over the real app: anyone reads and
//! sets them with no Admin PIN, a fresh server reads the defaults, values
//! out of range are refused, a change tells every browser, what is kept
//! survives a restart, and the starting Difficulty is where a joining Guest
//! and a new Profile start.

use openstar_protocol::profile::{Avatar, AvatarKey, Difficulty, NewProfile, PaletteKey, Profile};
use openstar_protocol::stage_options::StageOptions;
use openstar_protocol::{
    ChangeTopic, ClientMessage, Identity, JoinAs, NewGuest, PhoneId, ServerMessage, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};
use reqwest::StatusCode;

/// PUTs `body` with no Unlock and no Stage cookie, as any browser would.
async fn put(app: &TestApp, body: &serde_json::Value) -> reqwest::Response {
    app.http()
        .put(app.url("/api/stage-options"))
        .json(body)
        .send()
        .await
        .unwrap()
}

async fn read(app: &TestApp) -> StageOptions {
    app.get_json("/api/stage-options").await
}

fn changed_options() -> StageOptions {
    StageOptions {
        starting_difficulty: Difficulty::Easy,
        resume_countdown_seconds: 0,
        line_ratings: false,
        effects: false,
        song_video: false,
        preview_volume_percent: 40,
    }
}

#[tokio::test]
async fn a_fresh_server_reads_the_defaults() {
    let app = TestApp::start().await;
    assert_eq!(read(&app).await, StageOptions::default());
}

#[tokio::test]
async fn anyone_sets_them_and_they_survive_a_restart() {
    let mut app = TestApp::start().await;
    let body = serde_json::to_value(changed_options()).unwrap();
    let response = put(&app, &body).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<StageOptions>().await.unwrap(),
        changed_options()
    );

    app.restart().await;

    assert_eq!(read(&app).await, changed_options());
}

#[tokio::test]
async fn a_field_left_out_is_stored_as_its_default() {
    let app = TestApp::start().await;
    let response = put(&app, &serde_json::json!({ "effects": false })).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        read(&app).await,
        StageOptions {
            effects: false,
            ..StageOptions::default()
        }
    );
}

#[tokio::test]
async fn values_out_of_range_are_refused_and_nothing_changes() {
    let app = TestApp::start().await;
    for refused in [
        serde_json::json!({ "resumeCountdownSeconds": 6 }),
        serde_json::json!({ "previewVolumePercent": 110 }),
        serde_json::json!({ "previewVolumePercent": 45 }),
    ] {
        let response = put(&app, &refused).await;
        assert_eq!(
            response.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{refused}"
        );
        assert_eq!(
            response.json::<UserMessage>().await.unwrap(),
            UserMessage::InvalidMessage
        );
    }
    assert_eq!(read(&app).await, StageOptions::default());
}

#[tokio::test]
async fn a_change_tells_every_browser() {
    let app = TestApp::start().await;
    let mut socket = app.connect_ws().await;
    // Past the live state.
    socket.recv().await;
    put(&app, &serde_json::to_value(changed_options()).unwrap()).await;
    loop {
        if let ServerMessage::Changed { topics } = socket.recv().await
            && topics.contains(&ChangeTopic::StageOptions)
        {
            break;
        }
    }
}

async fn set_starting_difficulty(app: &TestApp, difficulty: Difficulty) {
    let body = serde_json::to_value(StageOptions {
        starting_difficulty: difficulty,
        ..StageOptions::default()
    })
    .unwrap();
    assert_eq!(put(app, &body).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_new_profile_starts_at_the_starting_difficulty() {
    let app = TestApp::start().await;
    set_starting_difficulty(&app, Difficulty::Hard).await;
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(&NewProfile {
            name: "Ada".into(),
            avatar: Avatar::BuiltIn {
                key: AvatarKey::Star,
            },
            favourite_colour: PaletteKey::Teal,
        })
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let profile: Profile = response.json().await.unwrap();
    assert_eq!(profile.last_difficulty, Difficulty::Hard);
}

/// The next Party snapshot on `socket`.
async fn next_party(socket: &mut WsClient) -> openstar_protocol::PartySnapshot {
    loop {
        match socket.recv().await {
            ServerMessage::PartyChanged { party, .. } => return party,
            ServerMessage::LiveState {
                party: Some(party), ..
            } => return party,
            _ => {}
        }
    }
}

#[tokio::test]
async fn a_joining_guest_starts_at_the_starting_difficulty() {
    let app = TestApp::start().await;
    set_starting_difficulty(&app, Difficulty::Easy).await;
    let mut stage = app.connect_stage().await;
    let code = next_party(&mut stage).await.join_code;

    let mut phone = app.connect_ws().await;
    phone
        .send(&ClientMessage::Join {
            phone_id: PhoneId("4b1d8f0e-0000-4000-8000-000000000001".into()),
            join_code: code,
            join_as: JoinAs::Guest(NewGuest {
                name: "Kim".into(),
                colour: PaletteKey::Cherry,
                avatar: Avatar::BuiltIn {
                    key: AvatarKey::Ghost,
                },
            }),
        })
        .await;
    loop {
        let party = next_party(&mut stage).await;
        if let Some(member) = party.members.first() {
            assert!(matches!(
                &member.identity,
                Identity::Guest {
                    difficulty: Difficulty::Easy,
                    ..
                }
            ));
            break;
        }
    }
}
