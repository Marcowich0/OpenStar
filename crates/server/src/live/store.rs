//! Persisting the live state in SQLite, so it survives a restart: the
//! current Party of each Stage in `parties`, its members (Profiles and
//! Guests) in `party_members`, its joined Phones in `joined_phones`, its Queue in `queue_requests`,
//! the head's Line-up in `line_ups` and `line_up_seats`, and the Local mic each member last sang
//! on in `last_local_mics`.

use std::collections::HashMap;

use openstar_protocol::library::SongId;
use openstar_protocol::mics::MicKey;
use openstar_protocol::profile::{Difficulty, PaletteKey, ProfileId};
use openstar_protocol::{
    Identity, JoinCode, JoinedPhone, LineUp, PartyId, PartyMember, PartyMemberId, PartySnapshot,
    PhoneId, Request, RequestId, RequestKind, Seat, SeatVoice, SongEnd, SongResults, StageId,
};
use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension};

use super::party;
use crate::db::Database;
use crate::profiles::{avatar_columns, read_avatar, unknown};

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
                        line_up: None,
                        playing: None,
                        results: None,
                        local_mics: Vec::new(),
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
        // While results show there is no head; otherwise the first Request
        // is the head. A Song in progress is never stored, so its Line-up
        // waits again after a restart.
        party.results = load_results(conn, &party.party_id)?;
        party.head = match party.results {
            Some(_) => None,
            None => party.queue.first().map(|r| r.request_id),
        };
        party.line_up = load_line_up(conn, &party.party_id)?
            .filter(|line_up| Some(line_up.request_id) == party.head);
        party::refresh_on_phone(&mut party);
        Ok(Some(party))
    })
    .await
}

fn load_members(conn: &Connection, party_id: &PartyId) -> rusqlite::Result<Vec<PartyMember>> {
    let mut statement = conn.prepare(
        "SELECT member_id, profile_id, colour, favourite_taken,
                guest_name, guest_avatar_kind, guest_avatar_ref, guest_difficulty
         FROM party_members WHERE party_id = ?1 ORDER BY member_id",
    )?;
    statement
        .query_map([&party_id.0], |row| {
            let colour: String = row.get(2)?;
            let identity = match row.get::<_, Option<u32>>(1)? {
                Some(profile_id) => Identity::Profile {
                    profile_id: ProfileId(profile_id),
                },
                None => {
                    let difficulty: String = row.get(7)?;
                    Identity::Guest {
                        name: row.get(4)?,
                        avatar: read_avatar(row, 5)?,
                        difficulty: Difficulty::from_key(&difficulty)
                            .ok_or_else(|| unknown(7, "Difficulty", &difficulty))?,
                    }
                }
            };
            Ok(PartyMember {
                member_id: PartyMemberId(row.get(0)?),
                identity,
                colour: PaletteKey::from_key(&colour).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        Type::Text,
                        format!("unknown palette key {colour:?}").into(),
                    )
                })?,
                favourite_taken: row.get(3)?,
                on_phone: false,
                singing: false,
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

/// The stored Line-up of `party_id`, without its computed Start
/// availability and warnings (the live-state task checks it).
fn load_line_up(conn: &Connection, party_id: &PartyId) -> rusqlite::Result<Option<LineUp>> {
    let line_up = conn
        .query_row(
            "SELECT request_id, duet FROM line_ups WHERE party_id = ?1",
            [&party_id.0],
            |row| {
                Ok(LineUp {
                    request_id: RequestId(row.get(0)?),
                    duet: row.get(1)?,
                    seats: Vec::new(),
                    can_start: false,
                    warnings: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut line_up) = line_up else {
        return Ok(None);
    };
    let mut statement = conn.prepare(
        "SELECT member_id, mic_kind, mic_id, voice, difficulty FROM line_up_seats
         WHERE party_id = ?1 ORDER BY seat",
    )?;
    line_up.seats = statement
        .query_map([&party_id.0], |row| {
            let mic = match (
                row.get::<_, Option<String>>(1)?.as_deref(),
                row.get::<_, Option<String>>(2)?,
            ) {
                (Some("phone"), Some(phone_id)) => Some(MicKey::Phone { phone_id }),
                (Some("localMic"), Some(local_mic_id)) => Some(MicKey::LocalMic { local_mic_id }),
                _ => None,
            };
            let voice: String = row.get(3)?;
            let difficulty: String = row.get(4)?;
            Ok(Seat {
                member_id: PartyMemberId(row.get(0)?),
                mic,
                voice: SeatVoice::from_key(&voice).ok_or_else(|| unknown(3, "Voice", &voice))?,
                difficulty: Difficulty::from_key(&difficulty)
                    .ok_or_else(|| unknown(4, "Difficulty", &difficulty))?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(line_up))
}

/// Replaces the stored Line-up of `party_id` with `line_up` (none clears it).
fn save_line_up_in(
    conn: &Connection,
    party_id: &PartyId,
    line_up: Option<&LineUp>,
) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM line_ups WHERE party_id = ?1", [&party_id.0])?;
    let Some(line_up) = line_up else {
        return Ok(());
    };
    conn.execute(
        "INSERT INTO line_ups (party_id, request_id, duet) VALUES (?1, ?2, ?3)",
        (&party_id.0, line_up.request_id.0, line_up.duet),
    )?;
    for (index, seat) in line_up.seats.iter().enumerate() {
        let (kind, id) = match &seat.mic {
            Some(MicKey::Phone { phone_id }) => (Some("phone"), Some(phone_id.as_str())),
            Some(MicKey::LocalMic { local_mic_id }) => {
                (Some("localMic"), Some(local_mic_id.as_str()))
            }
            None => (None, None),
        };
        conn.execute(
            "INSERT INTO line_up_seats (party_id, seat, member_id, mic_kind, mic_id, voice, difficulty)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            (
                &party_id.0,
                i64::try_from(index).unwrap_or(i64::MAX),
                seat.member_id.0,
                kind,
                id,
                seat.voice.as_str(),
                seat.difficulty.as_str(),
            ),
        )?;
    }
    Ok(())
}

/// The results `party_id` shows, if any.
fn load_results(conn: &Connection, party_id: &PartyId) -> rusqlite::Result<Option<SongResults>> {
    conn.query_row(
        "SELECT request_id, song_id, ended, players FROM party_results WHERE party_id = ?1",
        [&party_id.0],
        |row| {
            let ended: String = row.get(2)?;
            let players: String = row.get(3)?;
            Ok(SongResults {
                request_id: RequestId(row.get(0)?),
                song_id: SongId(row.get(1)?),
                ended: SongEnd::from_key(&ended).ok_or_else(|| unknown(2, "Song end", &ended))?,
                players: serde_json::from_str(&players).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        error.into(),
                    )
                })?,
            })
        },
    )
    .optional()
}

/// Replaces the stored results of `party_id` with `results` (none clears
/// them).
fn save_results_in(
    conn: &Connection,
    party_id: &PartyId,
    results: Option<&SongResults>,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM party_results WHERE party_id = ?1",
        [&party_id.0],
    )?;
    if let Some(results) = results {
        conn.execute(
            "INSERT INTO party_results (party_id, request_id, song_id, ended, players)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            (
                &party_id.0,
                results.request_id.0,
                results.song_id.0,
                results.ended.as_str(),
                serde_json::to_string(&results.players).unwrap_or_else(|_| "[]".to_owned()),
            ),
        )?;
    }
    Ok(())
}

/// The Local mic each member of `party_id` last sang on in that Party.
pub async fn load_last_local_mics(
    db: &Database,
    party_id: &PartyId,
) -> anyhow::Result<HashMap<PartyMemberId, String>> {
    let party_id = party_id.clone();
    db.call(move |conn| {
        let mut statement = conn
            .prepare("SELECT member_id, local_mic_id FROM last_local_mics WHERE party_id = ?1")?;
        statement
            .query_map([&party_id.0], |row| {
                Ok((PartyMemberId(row.get(0)?), row.get(1)?))
            })?
            .collect()
    })
    .await
}

/// Remembers that `member_id` sang on Local mic `local_mic_id` in
/// `party_id`, for the next prefill. Never kept across Parties.
#[cfg(test)]
pub async fn save_last_local_mic(
    db: &Database,
    party_id: &PartyId,
    member_id: PartyMemberId,
    local_mic_id: &str,
) -> anyhow::Result<()> {
    save_last_local_mics(db, party_id, vec![(member_id, local_mic_id.to_owned())]).await
}

/// Remembers, in one transaction, the Local mic each `(member, Local mic)`
/// pair sang on in `party_id` (recorded when a Song starts), for the next
/// prefill. Never kept across Parties.
pub async fn save_last_local_mics(
    db: &Database,
    party_id: &PartyId,
    sung: Vec<(PartyMemberId, String)>,
) -> anyhow::Result<()> {
    let party_id = party_id.clone();
    db.call(move |conn| {
        let tx = conn.transaction()?;
        for (member_id, local_mic_id) in &sung {
            tx.execute(
                "INSERT INTO last_local_mics (party_id, member_id, local_mic_id) VALUES (?1, ?2, ?3)
                 ON CONFLICT (party_id, member_id) DO UPDATE SET local_mic_id = excluded.local_mic_id",
                (&party_id.0, member_id.0, local_mic_id),
            )?;
        }
        tx.commit()
    })
    .await
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
/// deleted, the others get their place, requested Players and adder, and
/// the head's Line-up and the results showing are replaced. One
/// transaction.
pub async fn save_queue(db: &Database, party: &PartySnapshot) -> anyhow::Result<()> {
    let party = party.clone();
    db.call(move |conn| {
        let tx = conn.transaction()?;
        save_queue_in(&tx, &party)?;
        tx.commit()
    })
    .await
}

/// [`save_queue`] inside the caller's transaction; the caller commits.
pub(crate) fn save_queue_in(conn: &Connection, party: &PartySnapshot) -> rusqlite::Result<()> {
    let party_id = &party.party_id;
    let kept: Vec<u32> = party.queue.iter().map(|r| r.request_id.0).collect();
    conn.execute(
        "DELETE FROM queue_requests WHERE party_id = ?1
         AND id NOT IN (SELECT value FROM json_each(?2))",
        (
            &party_id.0,
            serde_json::to_string(&kept).unwrap_or_default(),
        ),
    )?;
    for (position, request) in party.queue.iter().enumerate() {
        conn.execute(
            "UPDATE queue_requests SET position = ?1, requested_players = ?2, adder = ?3
             WHERE id = ?4 AND party_id = ?5",
            (
                i64::try_from(position).unwrap_or(i64::MAX),
                players_json(&request.requested_players),
                request.adder.map(|m| m.0),
                request.request_id.0,
                &party_id.0,
            ),
        )?;
    }
    save_line_up_in(conn, party_id, party.line_up.as_ref())?;
    save_results_in(conn, party_id, party.results.as_ref())
}

/// Stores that member `member_id` left `party` (already applied to it):
/// its row goes, with its joined Phones and the Local mic it last sang on,
/// and the Queue and Line-up are stored as they are now. One transaction.
pub async fn save_leave(
    db: &Database,
    party: &PartySnapshot,
    member_id: PartyMemberId,
) -> anyhow::Result<()> {
    let party = party.clone();
    db.call(move |conn| {
        let tx = conn.transaction()?;
        save_leave_in(&tx, &party, member_id)?;
        tx.commit()
    })
    .await
}

/// [`save_leave`] inside the caller's transaction; the caller commits.
pub fn save_leave_in(
    conn: &Connection,
    party: &PartySnapshot,
    member_id: PartyMemberId,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM party_members WHERE party_id = ?1 AND member_id = ?2",
        (&party.party_id.0, member_id.0),
    )?;
    conn.execute(
        "DELETE FROM last_local_mics WHERE party_id = ?1 AND member_id = ?2",
        (&party.party_id.0, member_id.0),
    )?;
    save_queue_in(conn, party)
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
        save_join_in(&tx, &party_id, new_member.as_ref(), &phone)?;
        tx.commit()
    })
    .await
}

/// [`save_join`] inside the caller's transaction; the caller commits.
pub fn save_join_in(
    conn: &Connection,
    party_id: &PartyId,
    new_member: Option<&PartyMember>,
    phone: &JoinedPhone,
) -> rusqlite::Result<()> {
    if let Some(member) = new_member {
        insert_member_in(conn, party_id, member)?;
    }
    // An upsert keeps the row (and its place in the join order) when a
    // joined Phone switches to another member.
    conn.execute(
        "INSERT INTO joined_phones (party_id, phone_id, member_id) VALUES (?1, ?2, ?3)
         ON CONFLICT (party_id, phone_id) DO UPDATE SET member_id = excluded.member_id",
        (&party_id.0, &phone.phone_id.0, phone.member_id.0),
    )?;
    Ok(())
}

/// Stores a member that entered `party_id`.
fn insert_member_in(
    conn: &Connection,
    party_id: &PartyId,
    member: &PartyMember,
) -> rusqlite::Result<()> {
    let row = MemberColumns::of(member);
    conn.execute(
        "INSERT INTO party_members (party_id, member_id, profile_id, colour, favourite_taken,
                 guest_name, guest_avatar_kind, guest_avatar_ref, guest_difficulty)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        (
            &party_id.0,
            member.member_id.0,
            row.profile_id,
            member.colour.as_str(),
            member.favourite_taken,
            row.guest_name,
            row.guest_avatar_kind,
            row.guest_avatar_ref,
            row.guest_difficulty,
        ),
    )?;
    Ok(())
}

/// Stores an edit of the waiting Line-up of `party` (already applied to
/// it), with the member that entered the Party to take a seat, if any,
/// inside the caller's transaction; the caller commits.
pub fn save_seating_in(
    conn: &Connection,
    party: &PartySnapshot,
    new_member: Option<&PartyMember>,
) -> rusqlite::Result<()> {
    if let Some(member) = new_member {
        insert_member_in(conn, &party.party_id, member)?;
    }
    save_queue_in(conn, party)
}

/// Stores a member as it is now: its colour, and a Guest's name, avatar
/// and Difficulty. Its identity kind never changes.
pub fn update_member_in(
    conn: &Connection,
    party_id: &PartyId,
    member: &PartyMember,
) -> rusqlite::Result<()> {
    let row = MemberColumns::of(member);
    conn.execute(
        "UPDATE party_members SET colour = ?1, favourite_taken = ?2, guest_name = ?3,
             guest_avatar_kind = ?4, guest_avatar_ref = ?5, guest_difficulty = ?6
         WHERE party_id = ?7 AND member_id = ?8",
        (
            member.colour.as_str(),
            member.favourite_taken,
            row.guest_name,
            row.guest_avatar_kind,
            row.guest_avatar_ref,
            row.guest_difficulty,
            &party_id.0,
            member.member_id.0,
        ),
    )?;
    Ok(())
}

/// The identity columns of a `party_members` row.
struct MemberColumns<'a> {
    profile_id: Option<u32>,
    guest_name: Option<&'a str>,
    guest_avatar_kind: Option<&'static str>,
    guest_avatar_ref: Option<&'static str>,
    guest_difficulty: Option<&'static str>,
}

impl<'a> MemberColumns<'a> {
    fn of(member: &'a PartyMember) -> Self {
        match &member.identity {
            Identity::Profile { profile_id } => Self {
                profile_id: Some(profile_id.0),
                guest_name: None,
                guest_avatar_kind: None,
                guest_avatar_ref: None,
                guest_difficulty: None,
            },
            Identity::Guest {
                name,
                avatar,
                difficulty,
            } => {
                let (kind, reference) = avatar_columns(*avatar);
                Self {
                    profile_id: None,
                    guest_name: Some(name),
                    guest_avatar_kind: Some(kind),
                    guest_avatar_ref: Some(reference),
                    guest_difficulty: Some(difficulty.as_str()),
                }
            }
        }
    }
}
