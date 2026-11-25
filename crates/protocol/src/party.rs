//! The Party on the wire: its snapshot, the change events every accepted
//! change produces, and who made a change.
//!
//! After every accepted change the server sends every connected browser a
//! [`crate::ServerMessage::PartyChanged`]: the whole [`PartySnapshot`] plus
//! one [`ChangeEvent`]. A refused command gets a
//! [`crate::ServerMessage::Rejected`] with a [`crate::UserMessage`] code back.
//! Later Party tickets grow the snapshot (Party members, Queue, Line-up) and
//! add [`PartyEvent`] codes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::StageId;

/// Names one Party. A new Party always gets a new id; Score records keep it,
/// so Guests can be told apart across evenings.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PartyId(pub String);

/// The 4-digit code that lets a Phone join the current Party: four
/// characters `0`–`9`, kept as text so leading zeros survive. Not a secret,
/// and not the Admin PIN.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JoinCode(pub String);

/// Names one Party member within the Party.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PartyMemberId(pub u32);

/// The whole Party, as every browser sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PartySnapshot {
    pub party_id: PartyId,
    /// The Stage this Party runs on.
    pub stage_id: StageId,
    pub join_code: JoinCode,
    /// When the Party started, in milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub started_at_ms: i64,
}

/// Who made a change: the Stage, or the Party member using the Phone that
/// made it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Actor {
    Stage,
    Member { member_id: PartyMemberId },
}

/// What changed: a code plus its parameters, `{ "code": ..., "params": {...} }`
/// like [`crate::UserMessage`]. The frontend turns it into a toast with
/// `t(code, params)`; no English crosses the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "code",
    content = "params",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum PartyEvent {
    /// A Party started, by itself on the first Stage open of a fresh server
    /// or by New party on the Stage, with this Join code.
    PartyStarted { join_code: JoinCode },
}

/// One accepted change: who made it and what it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChangeEvent {
    pub actor: Actor,
    pub event: PartyEvent,
}
