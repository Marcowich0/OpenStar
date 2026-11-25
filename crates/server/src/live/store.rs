//! Persisting the live state in SQLite, so it survives a restart: the
//! current Party of each Stage in `parties`, its members in `party_members`
//! and its joined Phones in `joined_phones`.

use openstar_protocol::profile::{PaletteKey, ProfileId};
use openstar_protocol::{
    Identity, JoinCode, JoinedPhone, PartyId, PartyMember, PartyMemberId, PartySnapshot, PhoneId,
    StageId,
};
use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension};

use super::party;
use crate::db::Database;

/// The current Party of `stage_id`, if one has started, with its members
/// and joined Phones in the order they entered and joined.
pub async fn load_party(
    db: &Database,
    stage_id: &StageId,
) -> anyhow::Result<Option<PartySnapshot>> {
    let stage = stage_id.clone();
    db.call(move |conn| {
        let party = conn
            .query_row(
                "SELECT id, join_code, started_at_ms FROM parties WHERE stage_id = ?1",
                [&stage.0],
                |row| {
                    Ok(PartySnapshot {
                        party_id: PartyId(row.get(0)?),
                        stage_id: stage.clone(),
                        join_code: JoinCode(row.get(1)?),
                        started_at_ms: row.get(2)?,
                        members: Vec::new(),
                        phones: Vec::new(),
                    })
                },
            )
            .optional()?;
        let Some(mut party) = party else {
            return Ok(None);
        };
        party.members = load_members(conn, &party.party_id)?;
        party.phones = load_phones(conn, &party.party_id)?;
        party::refresh_on_phone(&mut party);
        Ok(Some(party))
    })
    .await
}

fn load_members(conn: &Connection, party_id: &PartyId) -> rusqlite::Result<Vec<PartyMember>> {
    let mut statement = conn.prepare(
        "SELECT member_id, profile_id, colour, favourite_taken FROM party_members
         WHERE party_id = ?1 ORDER BY member_id",
    )?;
    statement
        .query_map([&party_id.0], |row| {
            let colour: String = row.get(2)?;
            Ok(PartyMember {
                member_id: PartyMemberId(row.get(0)?),
                identity: Identity::Profile {
                    profile_id: ProfileId(row.get(1)?),
                },
                colour: PaletteKey::from_key(&colour).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        Type::Text,
                        format!("unknown palette key {colour:?}").into(),
                    )
                })?,
                favourite_taken: row.get(3)?,
                on_phone: false,
            })
        })?
        .collect()
}

fn load_phones(conn: &Connection, party_id: &PartyId) -> rusqlite::Result<Vec<JoinedPhone>> {
    let mut statement = conn.prepare(
        "SELECT phone_id, member_id FROM joined_phones WHERE party_id = ?1 ORDER BY rowid",
    )?;
    statement
        .query_map([&party_id.0], |row| {
            Ok(JoinedPhone {
                phone_id: PhoneId(row.get(0)?),
                member_id: PartyMemberId(row.get(1)?),
            })
        })?
        .collect()
}

/// Makes `party` the current Party of its Stage, replacing the one before
/// (whose members and joined Phones go with it).
pub async fn replace_party(db: &Database, party: &PartySnapshot) -> anyhow::Result<()> {
    let party = party.clone();
    db.call(move |conn| {
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM parties WHERE stage_id = ?1",
            [&party.stage_id.0],
        )?;
        tx.execute(
            "INSERT INTO parties (id, stage_id, join_code, started_at_ms) VALUES (?1, ?2, ?3, ?4)",
            (
                &party.party_id.0,
                &party.stage_id.0,
                &party.join_code.0,
                party.started_at_ms,
            ),
        )?;
        tx.commit()
    })
    .await
}

/// Stores a join: the member, when it entered the Party with it, and the
/// Phone with the member it uses now. One transaction.
pub async fn save_join(
    db: &Database,
    party_id: &PartyId,
    new_member: Option<&PartyMember>,
    phone: &JoinedPhone,
) -> anyhow::Result<()> {
    let party_id = party_id.clone();
    let new_member = new_member.cloned();
    let phone = phone.clone();
    db.call(move |conn| {
        let tx = conn.transaction()?;
        if let Some(member) = new_member {
            let Identity::Profile { profile_id } = member.identity;
            tx.execute(
                "INSERT INTO party_members (party_id, member_id, profile_id, colour, favourite_taken)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                (
                    &party_id.0,
                    member.member_id.0,
                    profile_id.0,
                    member.colour.as_str(),
                    member.favourite_taken,
                ),
            )?;
        }
        // An upsert keeps the row (and its place in the join order) when a
        // joined Phone switches to another member.
        tx.execute(
            "INSERT INTO joined_phones (party_id, phone_id, member_id) VALUES (?1, ?2, ?3)
             ON CONFLICT (party_id, phone_id) DO UPDATE SET member_id = excluded.member_id",
            (&party_id.0, &phone.phone_id.0, phone.member_id.0),
        )?;
        tx.commit()
    })
    .await
}
