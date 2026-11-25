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
use crate::profile::{PaletteKey, ProfileId};

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

/// Names one Party member within the Party. Numbered from 1 in the order
/// members enter it; a new Party starts again at 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PartyMemberId(pub u32);

/// The random id a browser makes on its first visit and keeps in its local
/// storage: how the server knows a Phone. Joined Phones, silent rejoin and a
/// Phone's Mic delay key on it. It is separate from the Profile id the Phone
/// remembers, since two Phones may hold one Profile.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PhoneId(pub String);

impl PhoneId {
    /// The longest Phone id the server accepts, in characters.
    pub const MAX_LENGTH: usize = 64;

    /// Whether this is a Phone id the server accepts: 1 to
    /// [`Self::MAX_LENGTH`] ASCII letters, digits and `-` (a UUID fits).
    pub fn is_valid(&self) -> bool {
        !self.0.is_empty()
            && self.0.len() <= Self::MAX_LENGTH
            && self
                .0
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
    }
}

/// Who a Party member is. Tagged by `kind`, so Guests can follow.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Identity {
    /// A Profile; its name and avatar come from `GET /api/profiles`.
    Profile { profile_id: ProfileId },
}

/// Who a Phone joins as. Tagged by `kind`, so joining as a Guest can follow.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum JoinAs {
    /// An existing Profile. Its Party colour is its favourite colour when
    /// free, otherwise the first free colour in palette order.
    Profile { profile_id: ProfileId },
}

/// A Profile or Guest that has entered the current Party.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PartyMember {
    pub member_id: PartyMemberId,
    pub identity: Identity,
    /// Held by no other Party member, until this one leaves the Party or the
    /// Party ends. Never saved back into a Profile.
    pub colour: PaletteKey,
    /// The Profile's favourite colour was held by another member when it
    /// entered, so it got the first free colour instead.
    pub favourite_taken: bool,
    /// At least one joined Phone uses this identity ("On a Phone"); `false`
    /// means Local mic only.
    pub on_phone: bool,
}

/// A Phone that has joined the current Party, and the Party member it uses
/// now. It stays joined while it sleeps or is disconnected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JoinedPhone {
    pub phone_id: PhoneId,
    pub member_id: PartyMemberId,
}

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
    /// Every Party member, in the order they entered.
    pub members: Vec<PartyMember>,
    /// Every joined Phone, in the order they joined.
    pub phones: Vec<JoinedPhone>,
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
    /// A Phone joined, and with it a new Party member entered the Party with
    /// this Party colour. `name` is the member's name at that moment.
    MemberJoined {
        member_id: PartyMemberId,
        name: String,
        colour: PaletteKey,
    },
    /// A Phone joined as a Party member that was already in the Party (or
    /// switched to one): no member was added and no colour changed hands.
    PhoneJoined {
        member_id: PartyMemberId,
        name: String,
    },
}

/// One accepted change: who made it and what it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChangeEvent {
    pub actor: Actor,
    pub event: PartyEvent,
}
