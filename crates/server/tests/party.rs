//! The Party's owner over real HTTP and WebSocket: the first Stage starts a
//! Party, New party, Stage takeover, refusals and restart survival.

use openstar_protocol::{
    Actor, ChangeEvent, ClientMessage, PartyEvent, PartySnapshot, ServerMessage, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

/// Reads the first message, which is always the live state.
async fn live_state(socket: &mut WsClient) -> (Option<PartySnapshot>, bool) {
    match socket.recv().await {
        ServerMessage::LiveState {
            party, is_stage, ..
        } => (party, is_stage),
        other => panic!("expected the live state first, got {other:?}"),
    }
}

async fn party_changed(socket: &mut WsClient) -> (PartySnapshot, ChangeEvent) {
    match socket.recv().await {
        ServerMessage::PartyChanged { party, change } => (party, change),
        other => panic!("expected a Party change, got {other:?}"),
    }
}

/// Asserts that nothing arrived on `socket` before the answer to a ping.
async fn heard_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(socket.recv().await, ServerMessage::Pong { nonce: 77 });
}

fn is_four_digits(code: &str) -> bool {
    code.len() == 4 && code.chars().all(|c| c.is_ascii_digit())
}

/// Opens the Stage on a fresh server and returns it with the Party it started.
async fn first_stage(app: &TestApp) -> (WsClient, PartySnapshot) {
    let mut stage = app.connect_stage().await;
    let (_, is_stage) = live_state(&mut stage).await;
    assert!(is_stage);
    let (party, _) = party_changed(&mut stage).await;
    (stage, party)
}

#[tokio::test]
async fn the_first_browser_to_open_the_stage_becomes_it_and_a_party_starts_by_itself() {
    let app = TestApp::start().await;
    let mut phone = app.connect_ws().await;
    assert_eq!(live_state(&mut phone).await, (None, false));

    let mut stage = app.connect_stage().await;
    let (party_at_connect, is_stage) = live_state(&mut stage).await;
    assert!(is_stage);
    let party = party_at_connect.expect("the Stage is told the Party it started");
    assert!(is_four_digits(&party.join_code.0), "{:?}", party.join_code);

    // Every connected browser hears of it, the Stage included.
    let expected_change = ChangeEvent {
        actor: Actor::Stage,
        event: PartyEvent::PartyStarted {
            join_code: party.join_code.clone(),
        },
    };
    for socket in [&mut stage, &mut phone] {
        assert_eq!(
            party_changed(socket).await,
            (party.clone(), expected_change.clone())
        );
    }
}

#[tokio::test]
async fn a_browser_that_connects_later_is_told_the_party_and_is_not_the_stage() {
    let app = TestApp::start().await;
    let (_stage, party) = first_stage(&app).await;
    let mut phone = app.connect_ws().await;
    assert_eq!(live_state(&mut phone).await, (Some(party), false));
}

#[tokio::test]
async fn new_party_from_the_stage_issues_a_new_join_code_to_everyone_without_a_pin() {
    let app = TestApp::start().await;
    let (mut stage, old) = first_stage(&app).await;
    let mut phone = app.connect_ws().await;
    live_state(&mut phone).await;

    stage.send(&ClientMessage::NewParty).await;

    let (new, change) = party_changed(&mut stage).await;
    assert_ne!(new.party_id, old.party_id);
    assert_ne!(new.join_code, old.join_code);
    assert!(is_four_digits(&new.join_code.0));
    assert_eq!(new.stage_id, old.stage_id);
    assert_eq!(
        change,
        ChangeEvent {
            actor: Actor::Stage,
            event: PartyEvent::PartyStarted {
                join_code: new.join_code.clone()
            },
        }
    );
    assert_eq!(party_changed(&mut phone).await, (new, change));
}

#[tokio::test]
async fn new_party_from_a_browser_that_is_not_the_stage_is_refused_and_changes_nothing() {
    let app = TestApp::start().await;
    let (mut stage, party) = first_stage(&app).await;
    let mut phone = app.connect_ws().await;
    live_state(&mut phone).await;

    phone.send(&ClientMessage::NewParty).await;
    assert_eq!(
        serde_json::to_value(phone.recv().await).unwrap(),
        serde_json::json!({ "type": "rejected", "reason": { "code": "notTheStage" } })
    );

    // Only the sender heard of it, and the Party is as it was.
    heard_nothing(&mut stage).await;
    let mut later = app.connect_ws().await;
    assert_eq!(live_state(&mut later).await, (Some(party), false));
}

#[tokio::test]
async fn new_party_is_refused_before_any_stage_has_opened() {
    let app = TestApp::start().await;
    let mut phone = app.connect_ws().await;
    live_state(&mut phone).await;
    phone.send(&ClientMessage::NewParty).await;
    assert_eq!(
        phone.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::NotTheStage
        }
    );
    let mut later = app.connect_ws().await;
    assert_eq!(live_state(&mut later).await, (None, false));
}

#[tokio::test]
async fn a_second_stage_takes_over_and_the_party_carries_on_unchanged() {
    let app = TestApp::start().await;
    let (mut old_stage, party) = first_stage(&app).await;
    let mut phone = app.connect_ws().await;
    live_state(&mut phone).await;

    let mut new_stage = app.connect_stage().await;
    assert_eq!(
        live_state(&mut new_stage).await,
        (Some(party.clone()), true)
    );
    assert_eq!(old_stage.recv().await, ServerMessage::StageMoved);
    // A takeover is no change to the Party: the Phones hear nothing.
    heard_nothing(&mut phone).await;
    heard_nothing(&mut new_stage).await;

    // The old Stage may no longer act as the Stage; the new one may.
    old_stage.send(&ClientMessage::NewParty).await;
    assert_eq!(
        old_stage.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::NotTheStage
        }
    );
    let mut later = app.connect_ws().await;
    assert_eq!(live_state(&mut later).await, (Some(party.clone()), false));

    new_stage.send(&ClientMessage::NewParty).await;
    let (new, _) = party_changed(&mut new_stage).await;
    assert_ne!(new.party_id, party.party_id);
    // The old Stage still sees the Party, like any other browser.
    assert_eq!(party_changed(&mut old_stage).await.0, new);
}

#[tokio::test]
async fn a_stage_reload_keeps_the_party() {
    let app = TestApp::start().await;
    let (stage, party) = first_stage(&app).await;
    drop(stage);

    let mut reloaded = app.connect_stage().await;
    assert_eq!(live_state(&mut reloaded).await, (Some(party), true));
    heard_nothing(&mut reloaded).await;
}

#[tokio::test]
async fn the_party_and_its_join_code_survive_a_restart_on_the_same_appdata_folder() {
    let mut app = TestApp::start().await;
    let (mut stage, _) = first_stage(&app).await;
    // Start a second Party, so what comes back is the current one.
    stage.send(&ClientMessage::NewParty).await;
    let (party, _) = party_changed(&mut stage).await;

    app.restart().await;
    stage.closed().await;

    let mut phone = app.connect_ws().await;
    assert_eq!(live_state(&mut phone).await, (Some(party.clone()), false));
    // The Stage comes back to the same Party; none starts by itself.
    let mut stage = app.connect_stage().await;
    assert_eq!(live_state(&mut stage).await, (Some(party), true));
    heard_nothing(&mut stage).await;
}
