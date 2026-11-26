//! Profiles over real HTTP and WebSocket: anyone creates, lists and edits
//! them, with no Unlock and no ownership.

use openstar_protocol::profile::{
    Avatar, AvatarKey, Difficulty, NewProfile, PaletteKey, Profile, ProfileEdit, ProfileId,
};
use openstar_protocol::{ChangeTopic, ServerMessage, UserMessage};
use openstar_test_harness::TestApp;
use reqwest::StatusCode;

fn built_in(key: AvatarKey) -> Avatar {
    Avatar::BuiltIn { key }
}

fn new_profile(name: &str) -> NewProfile {
    NewProfile {
        name: name.to_owned(),
        avatar: built_in(AvatarKey::Star),
        favourite_colour: PaletteKey::Cherry,
    }
}

fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

/// POSTs a new Profile and returns the status and the raw JSON body.
async fn create(app: &TestApp, body: &NewProfile) -> (StatusCode, serde_json::Value) {
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(body)
        .send()
        .await
        .unwrap();
    (response.status(), response.json().await.unwrap())
}

async fn create_ok(app: &TestApp, body: &NewProfile) -> Profile {
    let (status, json) = create(app, body).await;
    assert_eq!(status, StatusCode::CREATED, "{json}");
    serde_json::from_value(json).unwrap()
}

async fn edit(app: &TestApp, id: ProfileId, body: &ProfileEdit) -> (StatusCode, serde_json::Value) {
    let response = app
        .http()
        .patch(app.url(&format!("/api/profiles/{}", id.0)))
        .json(body)
        .send()
        .await
        .unwrap();
    (response.status(), response.json().await.unwrap())
}

fn refusal(json: serde_json::Value) -> UserMessage {
    serde_json::from_value(json).unwrap()
}

#[tokio::test]
async fn creating_a_profile_stores_it_with_medium_and_no_last_sung() {
    let app = TestApp::start().await;
    let before = now_ms();
    let created = create_ok(
        &app,
        &NewProfile {
            name: "  Bo  ".to_owned(),
            avatar: built_in(AvatarKey::Ghost),
            favourite_colour: PaletteKey::Teal,
        },
    )
    .await;
    let after = now_ms();

    assert_eq!(created.name, "Bo");
    assert_eq!(created.avatar, built_in(AvatarKey::Ghost));
    assert_eq!(created.favourite_colour, PaletteKey::Teal);
    assert_eq!(created.last_difficulty, Difficulty::Medium);
    assert_eq!(created.last_sung_at, None);
    assert!((before..=after).contains(&created.created_at));

    let listed: Vec<Profile> = app.get_json("/api/profiles").await;
    assert_eq!(listed, vec![created.clone()]);
    let one: Profile = app
        .get_json(&format!("/api/profiles/{}", created.id.0))
        .await;
    assert_eq!(one, created);
}

#[tokio::test]
async fn a_duplicate_name_is_refused_with_the_existing_profiles_id() {
    let app = TestApp::start().await;
    let bo = create_ok(&app, &new_profile("Bo")).await;

    for duplicate in ["Bo", "bo", "  BO ", "bO\t"] {
        let (status, json) = create(&app, &new_profile(duplicate)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{duplicate:?}");
        assert_eq!(
            refusal(json),
            UserMessage::ProfileNameTaken { profile_id: bo.id }
        );
    }
    let listed: Vec<Profile> = app.get_json("/api/profiles").await;
    assert_eq!(listed, vec![bo]);
}

#[tokio::test]
async fn a_name_too_long_or_empty_is_refused_with_a_code() {
    let app = TestApp::start().await;
    let (status, json) = create(&app, &new_profile("Seventeen chars!!")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        refusal(json),
        UserMessage::ProfileNameTooLong { max_length: 16 }
    );

    let (status, json) = create(&app, &new_profile("   ")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(refusal(json), UserMessage::ProfileNameEmpty);

    // Sixteen characters once the surrounding spaces are trimmed fit.
    let fits = create_ok(&app, &new_profile("  Sixteen chars ok  ")).await;
    assert_eq!(fits.name, "Sixteen chars ok");
}

#[tokio::test]
async fn anyone_may_edit_any_profiles_name_avatar_and_colour() {
    let app = TestApp::start().await;
    let bo = create_ok(&app, &new_profile("Bo")).await;

    let (status, json) = edit(
        &app,
        bo.id,
        &ProfileEdit {
            name: Some(" Bodil ".to_owned()),
            avatar: Some(built_in(AvatarKey::Butterfly)),
            favourite_colour: Some(PaletteKey::Tangerine),
        },
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");
    let edited: Profile = serde_json::from_value(json).unwrap();
    assert_eq!(
        edited,
        Profile {
            name: "Bodil".to_owned(),
            avatar: built_in(AvatarKey::Butterfly),
            favourite_colour: PaletteKey::Tangerine,
            ..bo.clone()
        }
    );

    // Only the fields sent change.
    let (status, json) = edit(
        &app,
        bo.id,
        &ProfileEdit {
            favourite_colour: Some(PaletteKey::Navy),
            ..ProfileEdit::default()
        },
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let recoloured: Profile = serde_json::from_value(json).unwrap();
    assert_eq!(
        recoloured,
        Profile {
            favourite_colour: PaletteKey::Navy,
            ..edited
        }
    );
    let stored: Profile = app.get_json(&format!("/api/profiles/{}", bo.id.0)).await;
    assert_eq!(stored, recoloured);
}

#[tokio::test]
async fn a_rename_keeps_the_id_and_follows_the_create_rules() {
    let app = TestApp::start().await;
    let bo = create_ok(&app, &new_profile("Bo")).await;
    let jonas = create_ok(&app, &new_profile("Jonas")).await;

    let rename = |name: &str| ProfileEdit {
        name: Some(name.to_owned()),
        ..ProfileEdit::default()
    };

    let (status, json) = edit(&app, jonas.id, &rename(" bo ")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        refusal(json),
        UserMessage::ProfileNameTaken { profile_id: bo.id }
    );

    let (status, json) = edit(&app, jonas.id, &rename("Seventeen chars!!")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        refusal(json),
        UserMessage::ProfileNameTooLong { max_length: 16 }
    );

    // A Profile may change the case of its own name.
    let (status, json) = edit(&app, bo.id, &rename("BO")).await;
    assert_eq!(status, StatusCode::OK, "{json}");
    let renamed: Profile = serde_json::from_value(json).unwrap();
    assert_eq!(renamed.id, bo.id);
    assert_eq!(renamed.name, "BO");
    assert_eq!(renamed.created_at, bo.created_at);

    // The old name is free again.
    let (status, _) = edit(&app, jonas.id, &rename("Bo")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = edit(&app, jonas.id, &rename("Jo")).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn editing_or_reading_a_missing_profile_answers_not_found() {
    let app = TestApp::start().await;
    let (status, json) = edit(&app, ProfileId(99), &ProfileEdit::default()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(refusal(json), UserMessage::ProfileNotFound);

    let response = app
        .http()
        .get(app.url("/api/profiles/99"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn creating_and_editing_send_a_change_notice() {
    let app = TestApp::start().await;
    let mut socket = app.connect_ws().await;
    assert!(matches!(
        socket.recv().await,
        ServerMessage::LiveState { .. }
    ));
    let changed = ServerMessage::Changed {
        topics: vec![ChangeTopic::Profiles],
    };

    let bo = create_ok(&app, &new_profile("Bo")).await;
    assert_eq!(socket.recv().await, changed);

    let (status, _) = edit(
        &app,
        bo.id,
        &ProfileEdit {
            avatar: Some(built_in(AvatarKey::Moon)),
            ..ProfileEdit::default()
        },
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(socket.recv().await, changed);
}

#[tokio::test]
async fn no_profile_appears_by_itself_and_deleting_one_needs_an_unlock() {
    let mut app = TestApp::start().await;
    let mut socket = app.connect_ws().await;
    let _ = socket.recv().await;
    let listed: Vec<Profile> = app.get_json("/api/profiles").await;
    assert!(listed.is_empty());

    let bo = create_ok(&app, &new_profile("Bo")).await;
    let response = app
        .http()
        .delete(app.url(&format!("/api/profiles/{}", bo.id.0)))
        .send()
        .await
        .unwrap();
    // The delete is the Admin area's guarded action (#199).
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // Profiles are kept data: they survive a restart unchanged.
    app.restart().await;
    let listed: Vec<Profile> = app.get_json("/api/profiles").await;
    assert_eq!(listed, vec![bo]);
}

#[tokio::test]
async fn a_colour_or_avatar_outside_the_keys_is_refused() {
    let app = TestApp::start().await;
    for body in [
        serde_json::json!({"name": "Bo", "avatar": {"kind": "builtIn", "key": "star"}, "favouriteColour": "#FF4B5C"}),
        serde_json::json!({"name": "Bo", "avatar": {"kind": "builtIn", "key": "unicorn"}, "favouriteColour": "cherry"}),
    ] {
        let response = app
            .http()
            .post(app.url("/api/profiles"))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{body}"
        );
    }
    let listed: Vec<Profile> = app.get_json("/api/profiles").await;
    assert!(listed.is_empty());
}
