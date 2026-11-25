//! The JSON wire format of the protocol messages, pinned with `insta`
//! snapshots and a `proptest` property.

use openstar_protocol::{ChangeTopic, ClientMessage, ServerMessage, StageId, UserMessage};
use proptest::prelude::*;

#[test]
fn rejected_message_wire_format() {
    insta::assert_json_snapshot!(ServerMessage::Rejected {
        reason: UserMessage::InvalidMessage,
    });
}

#[test]
fn user_message_with_parameters_wire_format() {
    insta::assert_json_snapshot!(UserMessage::PlaceholderTooLong { max_length: 1000 });
}

#[test]
fn live_state_wire_format() {
    insta::assert_json_snapshot!(ServerMessage::LiveState {
        stage_id: StageId("main".to_owned()),
        placeholder: "Hello".to_owned(),
    });
}

#[test]
fn change_notice_wire_format() {
    insta::assert_json_snapshot!(ServerMessage::Changed {
        topics: vec![ChangeTopic::Placeholder],
    });
}

proptest! {
    #[test]
    fn every_ping_round_trips_through_json(nonce in any::<u32>()) {
        let ping = ClientMessage::Ping { nonce };
        let text = serde_json::to_string(&ping).unwrap();
        prop_assert_eq!(serde_json::from_str::<ClientMessage>(&text).unwrap(), ping);
    }

    #[test]
    fn every_placeholder_change_round_trips_through_json(text in ".{0,40}") {
        let set = ClientMessage::SetPlaceholder { text };
        let json = serde_json::to_string(&set).unwrap();
        prop_assert_eq!(serde_json::from_str::<ClientMessage>(&json).unwrap(), set);
    }
}
