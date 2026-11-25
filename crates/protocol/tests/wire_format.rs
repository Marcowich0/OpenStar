//! The JSON wire format of the protocol messages, pinned with an `insta`
//! snapshot and a `proptest` property.

use openstar_protocol::{ClientMessage, RejectCode, ServerMessage};
use proptest::prelude::*;

#[test]
fn rejected_message_wire_format() {
    insta::assert_json_snapshot!(ServerMessage::Rejected {
        code: RejectCode::InvalidMessage,
    });
}

proptest! {
    #[test]
    fn every_ping_round_trips_through_json(nonce in any::<u32>()) {
        let ping = ClientMessage::Ping { nonce };
        let text = serde_json::to_string(&ping).unwrap();
        prop_assert_eq!(serde_json::from_str::<ClientMessage>(&text).unwrap(), ping);
    }
}
