//! The JSON wire format of the protocol messages, pinned with `insta`
//! snapshots and a `proptest` property.

use openstar_protocol::{
    Actor, ChangeEvent, ClientMessage, JoinCode, PartyEvent, PartyId, PartyMemberId, PartySnapshot,
    ServerMessage, StageId, UserMessage,
};
use proptest::prelude::*;

fn party() -> PartySnapshot {
    PartySnapshot {
        party_id: PartyId("0123456789abcdef0123456789abcdef".to_owned()),
        stage_id: StageId("main".to_owned()),
        join_code: JoinCode("0427".to_owned()),
        started_at_ms: 1_764_000_000_000,
    }
}

#[test]
fn rejected_message_wire_format() {
    insta::assert_json_snapshot!(ServerMessage::Rejected {
        reason: UserMessage::InvalidMessage,
    });
}

#[test]
fn refusal_code_wire_format() {
    insta::assert_json_snapshot!(ServerMessage::Rejected {
        reason: UserMessage::NotTheStage,
    });
}

#[test]
fn live_state_wire_format() {
    insta::assert_json_snapshot!(ServerMessage::LiveState {
        stage_id: StageId("main".to_owned()),
        party: Some(party()),
        is_stage: true,
    });
}

#[test]
fn party_changed_wire_format() {
    insta::assert_json_snapshot!(ServerMessage::PartyChanged {
        party: party(),
        change: ChangeEvent {
            actor: Actor::Stage,
            event: PartyEvent::PartyStarted {
                join_code: JoinCode("0427".to_owned()),
            },
        },
    });
}

#[test]
fn member_actor_wire_format() {
    insta::assert_json_snapshot!(Actor::Member {
        member_id: PartyMemberId(3),
    });
}

#[test]
fn stage_moved_and_new_party_wire_format() {
    assert_eq!(
        serde_json::to_string(&ServerMessage::StageMoved).unwrap(),
        r#"{"type":"stageMoved"}"#
    );
    assert_eq!(
        serde_json::from_str::<ClientMessage>(r#"{"type":"newParty"}"#).unwrap(),
        ClientMessage::NewParty
    );
}

proptest! {
    #[test]
    fn every_ping_round_trips_through_json(nonce in any::<u32>()) {
        let ping = ClientMessage::Ping { nonce };
        let text = serde_json::to_string(&ping).unwrap();
        prop_assert_eq!(serde_json::from_str::<ClientMessage>(&text).unwrap(), ping);
    }

    #[test]
    fn every_party_snapshot_round_trips_through_json(code in "[0-9]{4}", started in any::<i64>()) {
        let snapshot = PartySnapshot { join_code: JoinCode(code), started_at_ms: started, ..party() };
        let json = serde_json::to_string(&snapshot).unwrap();
        prop_assert_eq!(serde_json::from_str::<PartySnapshot>(&json).unwrap(), snapshot);
    }
}
