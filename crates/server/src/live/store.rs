//! Persisting the live state in SQLite, so it survives a restart: the
//! current Party of each Stage in `parties`, its members in `party_members`
//! its joined Phones in `joined_phones` and its Queue in `queue_requests`.

use openstar_protocol::library::SongId;
use openstar_protocol::profile::{PaletteKey, ProfileId};
use openstar_protocol::{
    Identity, JoinCode, JoinedPhone, PartyId, PartyMember, PartyMemberId, PartySnapshot, PhoneId,
    Request, RequestId, RequestKind, StageId,
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
                        queue: Vec::new(),
                        head: None,
                    })
                },
            )
            .optional()?;
        let Some(mut party) = party else {
            return Ok(None);
        };
        party.members = load_members(conn, &party.party_id)?;
        party.phones = load_phones(conn, &party.party_id)?;
        party.queue = load_queue(conn, &party.party_id)?;
        // Until the results screen (#87) is kept, a stored Queue always has
        // its first Request as the head.
        party.head = party.queue.first().map(|r| r.request_id);
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

fn load_queue(conn: &Connection, party_id: &PartyId) -> rusqlite::Result<Vec<Request>> {
    let mut statement = conn.prepare(
        "SELECT id, kind, song_id, requested_players, adder FROM queue_requests
         WHERE party_id = ?1 ORDER BY position",
    )?;
    statement
        .query_map([&party_id.0], |row| {
            let kind: String = row.get(1)?;
            let players: String = row.get(3)?;
            Ok(Request {
                request_id: RequestId(row.get(0)?),
                kind: RequestKind::from_key(&kind).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        Type::Text,
                        format!("unknown Request kind {kind:?}").into(),
                    )
                })?,
                song_id: SongId(row.get(2)?),
                requested_players: serde_json::from_str(&players).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(3, Type::Text, error.into())
                })?,
                adder: row.get::<_, Option<u32>>(4)?.map(PartyMemberId),
            })
        })?
        .collect()
}

fn players_json(players: &[PartyMemberId]) -> String {
    serde_json::to_string(players).unwrap_or_else(|_| "[]".to_owned())
}

/// Stores a new Request at the end of the Queue of `party_id` and returns
/// its new id. `request.request_id` is ignored.
pub async fn insert_request(
    db: &Database,
    party_id: &PartyId,
    request: &Request,
) -> anyhow::Result<RequestId> {
    let party_id = party_id.clone();
    let request = request.clone();
    db.call(move |conn| {
        conn.query_row(
            "INSERT INTO queue_requests (party_id, position, kind, song_id, requested_players, adder)
             VALUES (?1, (SELECT COALESCE(MAX(position) + 1, 0) FROM queue_requests WHERE party_id = ?1),
                     ?2, ?3, ?4, ?5)
             RETURNING id",
            (
                &party_id.0,
                request.kind.as_str(),
                request.song_id.0,
                players_json(&request.requested_players),
                request.adder.map(|m| m.0),
            ),
            |row| row.get(0).map(RequestId),
        )
    })
    .await
}

/// Stores the Queue of `party` as it is now: Requests no longer in it are
/// deleted, the others get their place and requested Players. One
/// transaction.
pub async fn save_queue(db: &Database, party: &PartySnapshot) -> anyhow::Result<()> {
    let party_id = party.party_id.clone();
    let queue = party.queue.clone();
    db.call(move |conn| {
        let tx = conn.transaction()?;
        let kept: Vec<u32> = queue.iter().map(|r| r.request_id.0).collect();
        tx.execute(
            "DELETE FROM queue_requests WHERE party_id = ?1
             AND id NOT IN (SELECT value FROM json_each(?2))",
            (
                &party_id.0,
                serde_json::to_string(&kept).unwrap_or_default(),
            ),
        )?;
        for (position, request) in queue.iter().enumerate() {
            tx.execute(
                "UPDATE queue_requests SET position = ?1, requested_players = ?2
                 WHERE id = ?3 AND party_id = ?4",
                (
                    i64::try_from(position).unwrap_or(i64::MAX),
                    players_json(&request.requested_players),
                    request.request_id.0,
                    &party_id.0,
                ),
            )?;
        }
        tx.commit()
    })
    .await
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
