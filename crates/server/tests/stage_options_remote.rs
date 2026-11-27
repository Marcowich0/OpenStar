//! The Stage options from a Remote (#271): a joined Phone sets them over the
//! WebSocket with no Admin PIN, they are kept like a `PUT`, every browser
//! gets the change notice, and the Party change names the Phone's member and
//! the options it changed, so the Stage toasts "Bo changed Effects". A
//! connection not in the Party and values out of range are refused, and
//! nothing changes.

use openstar_protocol::profile::{Avatar, AvatarKey, PaletteKey};
use openstar_protocol::stage_options::{Effects, StageOptions};
use openstar_protocol::{
    Actor, ChangeEvent, ChangeTopic, ClientMessage, JoinAs, JoinCode, NewGuest, PartyEvent,
    PhoneId, ServerMessage, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

const BO: &str = "4b1d8f0e-0000-4000-8000-000000000001";

async fn read(app: &TestApp) -> StageOptions {
    app.get_json("/api/stage-options").await
}

/// Opens the Stage and returns it with the Join code of its first Party.
async fn open_stage(app: &TestApp) -> (WsClient, JoinCode) {
    let mut stage = app.connect_stage().await;
    loop {
        match stage.recv().await {
            ServerMessage::LiveState {
                party: Some(party), ..
            }
            | ServerMessage::PartyChanged { party, .. } => return (stage, party.join_code),
            _ => {}
        }
    }
}

/// A Phone joined to the Party as the Guest Bo, past its own status.
async fn joined_phone(app: &TestApp, code: &JoinCode) -> WsClient {
    let mut phone = app.connect_ws().await;
    phone
        .send(&ClientMessage::Join {
            phone_id: PhoneId(BO.into()),
            join_code: code.clone(),
            join_as: JoinAs::Guest(NewGuest {
                name: "Bo".into(),
                colour: PaletteKey::Sky,
                avatar: Avatar::BuiltIn {
                    key: AvatarKey::Star,
                },
            }),
        })
        .await;
    loop {
        if let ServerMessage::PhoneStatus { member_id: Some(_) } = phone.recv().await {
            return phone;
        }
    }
}

/// The next Stage options Party change on `socket`, past everything else.
async fn next_options_change(socket: &mut WsClient) -> ChangeEvent {
    loop {
        if let ServerMessage::PartyChanged { change, .. } = socket.recv().await
            && matches!(change.event, PartyEvent::StageOptionsChanged { .. })
        {
            return change;
        }
    }
}

/// The next refusal on `socket`, past everything else.
async fn next_refusal(socket: &mut WsClient) -> UserMessage {
    loop {
        if let ServerMessage::Rejected { reason } = socket.recv().await {
            return reason;
        }
    }
}

#[tokio::test]
async fn a_phone_sets_them_and_the_stage_hears_who_changed_what() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut phone = joined_phone(&app, &code).await;
    let member_id = loop {
        if let ServerMessage::PartyChanged { party, .. } = stage.recv().await
            && let Some(member) = party.members.first()
        {
            break member.member_id;
        }
    };

    let options = StageOptions {
        effects: Effects::Off,
        ..StageOptions::default()
    };
    phone
        .send(&ClientMessage::SetStageOptions {
            options: options.clone(),
        })
        .await;

    // The Stage refetches on the change notice, then toasts the change.
    loop {
        if let ServerMessage::Changed { topics } = stage.recv().await
            && topics.contains(&ChangeTopic::StageOptions)
        {
            break;
        }
    }
    assert_eq!(
        next_options_change(&mut stage).await,
        ChangeEvent {
            actor: Actor::Member { member_id },
            event: PartyEvent::StageOptionsChanged {
                options: vec!["effects".into()],
            },
        }
    );
    assert_eq!(read(&app).await, options);
}

#[tokio::test]
async fn the_change_names_every_option_that_changed() {
    let app = TestApp::start().await;
    let (mut stage, code) = open_stage(&app).await;
    let mut phone = joined_phone(&app, &code).await;
    phone
        .send(&ClientMessage::SetStageOptions {
            options: StageOptions {
                line_ratings: false,
                preview_volume_percent: 50,
                ..StageOptions::default()
            },
        })
        .await;
    let PartyEvent::StageOptionsChanged { options } = next_options_change(&mut stage).await.event
    else {
        unreachable!()
    };
    assert_eq!(options, vec!["lineRatings", "previewVolumePercent"]);
}

#[tokio::test]
async fn the_same_options_again_change_nothing_and_toast_nothing() {
    let app = TestApp::start().await;
    let (_stage, code) = open_stage(&app).await;
    let mut phone = joined_phone(&app, &code).await;
    phone
        .send(&ClientMessage::SetStageOptions {
            options: StageOptions::default(),
        })
        .await;
    phone.send(&ClientMessage::Ping { nonce: 9 }).await;
    loop {
        match phone.recv().await {
            ServerMessage::Pong { nonce: 9 } => break,
            ServerMessage::PartyChanged { change, .. } => {
                assert!(
                    !matches!(change.event, PartyEvent::StageOptionsChanged { .. }),
                    "{change:?}"
                );
            }
            ServerMessage::Rejected { reason } => panic!("refused: {reason:?}"),
            _ => {}
        }
    }
}

#[tokio::test]
async fn a_connection_not_in_the_party_is_refused() {
    let app = TestApp::start().await;
    let _stage = open_stage(&app).await;
    let mut stranger = app.connect_ws().await;
    stranger
        .send(&ClientMessage::SetStageOptions {
            options: StageOptions {
                effects: Effects::Off,
                ..StageOptions::default()
            },
        })
        .await;
    assert_eq!(next_refusal(&mut stranger).await, UserMessage::NotInParty);
    assert_eq!(read(&app).await, StageOptions::default());
}

#[tokio::test]
async fn values_out_of_range_are_refused_and_nothing_changes() {
    let app = TestApp::start().await;
    let (_stage, code) = open_stage(&app).await;
    let mut phone = joined_phone(&app, &code).await;
    phone
        .send(&ClientMessage::SetStageOptions {
            options: StageOptions {
                preview_volume_percent: 45,
                ..StageOptions::default()
            },
        })
        .await;
    assert_eq!(next_refusal(&mut phone).await, UserMessage::InvalidMessage);
    assert_eq!(read(&app).await, StageOptions::default());
}
