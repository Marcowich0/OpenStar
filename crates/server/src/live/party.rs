//! The Party's own rules, free of the task and the database: drawing a Join
//! code and a Party id, starting a Party, a Phone joining it as a Profile or
//! a new Guest with a Party colour, editing a member inside the Party, and a
//! member leaving it.
//!
//! Clashes with Profile names need the database, so the task checks those;
//! everything here is about the Party alone.

use openstar_protocol::mics::MicKey;
use openstar_protocol::profile::{Avatar, Difficulty, PaletteKey, ProfileId};
use openstar_protocol::{
    Identity, JoinCode, JoinedPhone, MemberEdit, PartyId, PartyMember, PartyMemberId,
    PartySnapshot, PhoneId, StageId, UserMessage,
};

use crate::profiles::{CheckedName, name_key};

/// How many Join codes there are: `0000` to `9999`.
const JOIN_CODES: u16 = 10_000;

/// Starts a Party on `stage_id` at `now_ms`, with a new id and a Join code
/// that differs from the `previous` Party's.
pub fn start_party(
    stage_id: &StageId,
    previous: Option<&PartySnapshot>,
    now_ms: i64,
) -> anyhow::Result<PartySnapshot> {
    Ok(PartySnapshot {
        party_id: draw_party_id()?,
        stage_id: stage_id.clone(),
        join_code: draw_join_code(previous.map(|party| &party.join_code))?,
        started_at_ms: now_ms,
        members: Vec::new(),
        phones: Vec::new(),
        queue: Vec::new(),
        head: None,
        line_up: None,
        playing: None,
        results: None,
        // Local mics are not the Party's: a new Party sees the same ones.
        local_mics: previous
            .map(|party| party.local_mics.clone())
            .unwrap_or_default(),
    })
}

/// What [`join_phone`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Joined {
    /// The Party member the Phone uses now.
    pub member_id: PartyMemberId,
    /// Whether that member entered the Party with this join.
    pub new_member: bool,
}

/// The colour a Profile with `favourite` gets on entering a Party whose
/// members hold `held`: its favourite when free, else the first free colour
/// in palette order; `None` when all twelve are held.
pub fn party_colour(favourite: PaletteKey, held: &[PaletteKey]) -> Option<PaletteKey> {
    if !held.contains(&favourite) {
        return Some(favourite);
    }
    PaletteKey::ALL
        .into_iter()
        .find(|colour| !held.contains(colour))
}

/// Joins `phone_id` to `party` as the Profile `profile_id`, whose favourite
/// colour is `favourite` (see [`enter_profile`]). A Phone that was joined as
/// someone else switches; that member stays in the Party.
pub fn join_phone(
    party: &mut PartySnapshot,
    phone_id: PhoneId,
    profile_id: ProfileId,
    favourite: PaletteKey,
) -> Result<Joined, UserMessage> {
    let joined = enter_profile(party, profile_id, favourite)?;
    use_on_phone(party, phone_id, joined.member_id);
    Ok(joined)
}

/// Makes the Profile `profile_id`, whose favourite colour is `favourite`, a
/// member of `party` with no Phone (seating it on a Line-up). A Profile
/// already in the Party adds no member and keeps its colour; a new one gets
/// [`party_colour`], or is refused with [`UserMessage::PartyFull`] (and
/// nothing changes).
pub fn enter_profile(
    party: &mut PartySnapshot,
    profile_id: ProfileId,
    favourite: PaletteKey,
) -> Result<Joined, UserMessage> {
    let identity = Identity::Profile { profile_id };
    if let Some(member) = party.members.iter().find(|m| m.identity == identity) {
        return Ok(Joined {
            member_id: member.member_id,
            new_member: false,
        });
    }
    let held: Vec<PaletteKey> = party.members.iter().map(|m| m.colour).collect();
    let colour = party_colour(favourite, &held).ok_or(UserMessage::PartyFull)?;
    let member_id = next_member_id(party);
    party.members.push(PartyMember {
        member_id,
        identity,
        colour,
        favourite_taken: colour != favourite,
        on_phone: false,
        singing: false,
    });
    Ok(Joined {
        member_id,
        new_member: true,
    })
}

/// Joins `phone_id` to `party` as a new Guest (see [`enter_guest`]). A
/// Phone that was joined as someone else switches; that member stays in the
/// Party.
pub fn join_guest(
    party: &mut PartySnapshot,
    phone_id: PhoneId,
    name: &CheckedName,
    colour: PaletteKey,
    avatar: Avatar,
) -> Result<Joined, UserMessage> {
    let member_id = enter_guest(party, name, colour, avatar)?;
    use_on_phone(party, phone_id, member_id);
    Ok(Joined {
        member_id,
        new_member: true,
    })
}

/// Adds a new Guest named `name` (already through the name rules) with
/// `colour` and `avatar` to `party`, starting on Medium, with no Phone.
/// Refused, with nothing changed, with [`UserMessage::PartyFull`] when
/// twelve colours are held, [`UserMessage::ColourTaken`] when `colour` is
/// held and [`UserMessage::NameTakenTonight`] when a Guest has the name.
pub fn enter_guest(
    party: &mut PartySnapshot,
    name: &CheckedName,
    colour: PaletteKey,
    avatar: Avatar,
) -> Result<PartyMemberId, UserMessage> {
    if is_full(party) {
        return Err(UserMessage::PartyFull);
    }
    if colour_holder(party, colour).is_some() {
        return Err(UserMessage::ColourTaken);
    }
    if let Some(member_id) = guest_named(party, &name.key, None) {
        return Err(UserMessage::NameTakenTonight { member_id });
    }
    let member_id = next_member_id(party);
    party.members.push(PartyMember {
        member_id,
        identity: Identity::Guest {
            name: name.display.clone(),
            avatar,
            difficulty: Difficulty::Medium,
        },
        colour,
        favourite_taken: false,
        on_phone: false,
        singing: false,
    });
    Ok(member_id)
}

/// Edits member `member_id` inside the Party. `name` (already through the
/// name rules) must not be another Guest's; for a Guest it and `edit.avatar`
/// become the Guest's own, for a Profile the caller changes the Profile.
/// `edit.colour` must be free or the member's own; it becomes the Party
/// colour (for a Profile the caller saves it as the favourite too, so the
/// favourite is no longer taken). Nothing changes when refused.
pub fn edit_member(
    party: &mut PartySnapshot,
    member_id: PartyMemberId,
    name: Option<&CheckedName>,
    edit: &MemberEdit,
) -> Result<(), UserMessage> {
    if !party.members.iter().any(|m| m.member_id == member_id) {
        return Err(UserMessage::MemberNotFound);
    }
    if let Some(name) = name
        && let Some(holder) = guest_named(party, &name.key, Some(member_id))
    {
        return Err(UserMessage::NameTakenTonight { member_id: holder });
    }
    if let Some(colour) = edit.colour
        && colour_holder(party, colour).is_some_and(|holder| holder != member_id)
    {
        return Err(UserMessage::ColourTaken);
    }
    let Some(member) = party.members.iter_mut().find(|m| m.member_id == member_id) else {
        return Err(UserMessage::MemberNotFound);
    };
    if let Some(colour) = edit.colour {
        member.colour = colour;
        member.favourite_taken = false;
    }
    if let Identity::Guest {
        name: guest_name,
        avatar,
        ..
    } = &mut member.identity
    {
        if let Some(name) = name {
            guest_name.clone_from(&name.display);
        }
        if let Some(new_avatar) = edit.avatar {
            *avatar = new_avatar;
        }
    }
    Ok(())
}

/// What [`leave`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Left {
    /// The member as it was, with the colour it freed.
    pub member: PartyMember,
    /// Every Phone that used it, in join order: all of them are out of the
    /// Party now.
    pub phones: Vec<PhoneId>,
}

/// Member `member_id` leaves `party` (Leave party, or removed from the
/// people list): its colour is free at once, every Phone using it is out of
/// the Party and is no seat's Mic any more, and it is dropped from the
/// requested Players of every Request (and as their adder). Refused, with
/// nothing changed, with [`UserMessage::MemberSinging`] while it sits in the
/// Line-up (waiting or playing) or, during a Song, while one of its Phones
/// is a seat's Mic, and [`UserMessage::MemberNotFound`] when it is not a
/// member.
pub fn leave(party: &mut PartySnapshot, member_id: PartyMemberId) -> Result<Left, UserMessage> {
    let index = party
        .members
        .iter()
        .position(|member| member.member_id == member_id)
        .ok_or(UserMessage::MemberNotFound)?;
    let seated = party
        .line_up
        .as_ref()
        .is_some_and(|line_up| line_up.seats.iter().any(|s| s.member_id == member_id));
    // During a Song the Line-up is fixed, so no seat may lose its Mic.
    let lends_a_mic = party.playing.is_some()
        && party.line_up.as_ref().is_some_and(|line_up| {
            line_up.seats.iter().any(|seat| {
                matches!(&seat.mic, Some(MicKey::Phone { phone_id }) if party.phones.iter().any(
                    |phone| phone.member_id == member_id && &phone.phone_id.0 == phone_id
                ))
            })
        });
    if seated || lends_a_mic {
        return Err(UserMessage::MemberSinging);
    }
    let member = party.members.remove(index);
    let (gone, kept): (Vec<JoinedPhone>, Vec<JoinedPhone>) = std::mem::take(&mut party.phones)
        .into_iter()
        .partition(|phone| phone.member_id == member_id);
    party.phones = kept;
    let phones: Vec<PhoneId> = gone.into_iter().map(|phone| phone.phone_id).collect();
    for request in &mut party.queue {
        request
            .requested_players
            .retain(|&player| player != member_id);
    }
    if let Some(line_up) = party.line_up.as_mut() {
        for seat in &mut line_up.seats {
            if let Some(MicKey::Phone { phone_id }) = &seat.mic
                && phones.iter().any(|phone| &phone.0 == phone_id)
            {
                seat.mic = None;
            }
        }
    }
    refresh_on_phone(party);
    Ok(Left { member, phones })
}

/// Profile `profile_id` is being deleted: when it is a member of `party` it
/// leaves the Party like [`leave`], and first loses its seats in a waiting
/// Line-up (a delete takes it off the Song). `None` when it is no member.
/// Refused, with nothing changed, with [`UserMessage::ProfileSinging`] while
/// it sings in the playing Song: seated, or one of its Phones is a seat's Mic.
pub fn delete_profile(
    party: &mut PartySnapshot,
    profile_id: ProfileId,
) -> Result<Option<Left>, UserMessage> {
    let Some(member_id) = party
        .members
        .iter()
        .find(|member| member.identity == Identity::Profile { profile_id })
        .map(|member| member.member_id)
    else {
        return Ok(None);
    };
    let mut after = party.clone();
    if after.playing.is_none()
        && let Some(line_up) = after.line_up.as_mut()
    {
        line_up.seats.retain(|seat| seat.member_id != member_id);
    }
    let left = leave(&mut after, member_id).map_err(|refused| match refused {
        UserMessage::MemberSinging => UserMessage::ProfileSinging,
        other => other,
    })?;
    *party = after;
    Ok(Some(left))
}

/// Whether all twelve colours are held, so no new member can enter.
pub fn is_full(party: &PartySnapshot) -> bool {
    PaletteKey::ALL
        .into_iter()
        .all(|colour| colour_holder(party, colour).is_some())
}

/// The member holding `colour`, if any.
pub fn colour_holder(party: &PartySnapshot, colour: PaletteKey) -> Option<PartyMemberId> {
    party
        .members
        .iter()
        .find(|member| member.colour == colour)
        .map(|member| member.member_id)
}

/// The Guest other than `except` whose name has the name key `key`.
pub fn guest_named(
    party: &PartySnapshot,
    key: &str,
    except: Option<PartyMemberId>,
) -> Option<PartyMemberId> {
    party
        .members
        .iter()
        .filter(|member| Some(member.member_id) != except)
        .find(|member| matches!(&member.identity, Identity::Guest { name, .. } if name_key(name) == key))
        .map(|member| member.member_id)
}

/// Makes `phone_id` use `member_id`, joining it if it was not joined.
fn use_on_phone(party: &mut PartySnapshot, phone_id: PhoneId, member_id: PartyMemberId) {
    match party.phones.iter_mut().find(|p| p.phone_id == phone_id) {
        Some(phone) => phone.member_id = member_id,
        None => party.phones.push(JoinedPhone {
            phone_id,
            member_id,
        }),
    }
    refresh_on_phone(party);
}

/// The id the next member to enter gets: one past the highest in use, by a
/// member or as the adder of a Request (an adder who left keeps the id, so
/// a newcomer never seems to have added that Request).
fn next_member_id(party: &PartySnapshot) -> PartyMemberId {
    let highest = party
        .members
        .iter()
        .map(|m| m.member_id.0)
        .chain(party.queue.iter().filter_map(|r| r.adder.map(|a| a.0)))
        .max();
    PartyMemberId(highest.map_or(1, |id| id + 1))
}

/// Sets each member's `on_phone` from the joined Phones.
pub fn refresh_on_phone(party: &mut PartySnapshot) {
    for member in &mut party.members {
        member.on_phone = party
            .phones
            .iter()
            .any(|phone| phone.member_id == member.member_id);
    }
}

/// Four random digits, never equal to `previous`.
pub fn draw_join_code(previous: Option<&JoinCode>) -> anyhow::Result<JoinCode> {
    draw_join_code_from(previous, random_u16)
}

/// [`draw_join_code`] with the randomness handed in, so a test can rig it.
fn draw_join_code_from(
    previous: Option<&JoinCode>,
    mut random: impl FnMut() -> anyhow::Result<u16>,
) -> anyhow::Result<JoinCode> {
    loop {
        // Rejection sampling keeps every code equally likely.
        let value = random()?;
        if value >= u16::MAX - u16::MAX % JOIN_CODES {
            continue;
        }
        let code = JoinCode(format!("{:04}", value % JOIN_CODES));
        if previous != Some(&code) {
            return Ok(code);
        }
    }
}

/// 128 random bits as 32 lowercase hex digits.
fn draw_party_id() -> anyhow::Result<PartyId> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| anyhow::anyhow!("no OS randomness: {error}"))?;
    Ok(PartyId(bytes.iter().map(|b| format!("{b:02x}")).collect()))
}

fn random_u16() -> anyhow::Result<u16> {
    let mut bytes = [0_u8; 2];
    getrandom::fill(&mut bytes).map_err(|error| anyhow::anyhow!("no OS randomness: {error}"))?;
    Ok(u16::from_le_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openstar_protocol::library::SongId;
    use openstar_protocol::mics::MicKey;
    use openstar_protocol::profile::PaletteKey::{self, *};
    use openstar_protocol::profile::ProfileId;
    use openstar_protocol::profile::{Avatar, AvatarKey, Difficulty};
    use openstar_protocol::{
        Identity, LineUp, PartyMemberId, PhoneId, Request, RequestId, RequestKind, Seat, SeatVoice,
        UserMessage,
    };
    use proptest::prelude::*;

    fn party() -> PartySnapshot {
        start_party(&StageId("main".into()), None, 1).unwrap()
    }

    fn phone(n: u32) -> PhoneId {
        PhoneId(format!("phone-{n}"))
    }

    fn colours(party: &PartySnapshot) -> Vec<PaletteKey> {
        party.members.iter().map(|member| member.colour).collect()
    }

    #[test]
    fn a_profile_gets_its_favourite_colour_when_it_is_free() {
        let mut party = party();
        let joined = join_phone(&mut party, phone(1), ProfileId(1), Teal).unwrap();
        assert_eq!(
            joined,
            Joined {
                member_id: PartyMemberId(1),
                new_member: true
            }
        );
        let member = &party.members[0];
        assert_eq!(
            member.identity,
            Identity::Profile {
                profile_id: ProfileId(1)
            }
        );
        assert_eq!(member.colour, Teal);
        assert!(!member.favourite_taken);
        assert!(member.on_phone);
        assert_eq!(party.phones.len(), 1);
        assert_eq!(party.phones[0].phone_id, phone(1));
        assert_eq!(party.phones[0].member_id, PartyMemberId(1));
    }

    #[test]
    fn a_taken_favourite_gives_the_first_free_colour_in_palette_order() {
        let mut party = party();
        join_phone(&mut party, phone(1), ProfileId(1), Cherry).unwrap();
        join_phone(&mut party, phone(2), ProfileId(2), Navy).unwrap();
        join_phone(&mut party, phone(3), ProfileId(3), Navy).unwrap();
        assert_eq!(colours(&party), vec![Cherry, Navy, Sky]);
        assert!(party.members[2].favourite_taken);
        assert_eq!(party.members[2].member_id, PartyMemberId(3));
    }

    #[test]
    fn a_second_phone_on_a_member_adds_no_member_and_keeps_its_colour() {
        let mut party = party();
        join_phone(&mut party, phone(1), ProfileId(1), Lime).unwrap();
        let joined = join_phone(&mut party, phone(2), ProfileId(1), Lime).unwrap();
        assert_eq!(
            joined,
            Joined {
                member_id: PartyMemberId(1),
                new_member: false
            }
        );
        assert_eq!(colours(&party), vec![Lime]);
        assert_eq!(party.phones.len(), 2);
    }

    fn full_party() -> PartySnapshot {
        let mut party = party();
        for n in 1..=12 {
            join_phone(&mut party, phone(n), ProfileId(n), Cherry).unwrap();
        }
        party
    }

    #[test]
    fn with_twelve_colours_held_a_new_profile_is_refused_and_nothing_changes() {
        let mut party = full_party();
        let before = party.clone();
        assert_eq!(
            join_phone(&mut party, phone(13), ProfileId(13), Cherry),
            Err(UserMessage::PartyFull)
        );
        assert_eq!(party, before);
        // A Profile already in the Party still joins on another Phone.
        let joined = join_phone(&mut party, phone(13), ProfileId(5), Cherry).unwrap();
        assert!(!joined.new_member);
        assert_eq!(party.members.len(), 12);
        let mut held = colours(&party);
        held.sort_by_key(|c| PaletteKey::ALL.iter().position(|k| k == c));
        assert_eq!(held, PaletteKey::ALL.to_vec());
    }

    #[test]
    fn a_phone_that_joins_again_as_someone_else_switches_and_the_old_member_stays() {
        let mut party = party();
        join_phone(&mut party, phone(1), ProfileId(1), Berry).unwrap();
        join_phone(&mut party, phone(1), ProfileId(2), Mint).unwrap();
        assert_eq!(colours(&party), vec![Berry, Mint]);
        assert_eq!(party.phones.len(), 1);
        assert_eq!(party.phones[0].member_id, PartyMemberId(2));
        // The first member keeps its colour but is no longer on a Phone.
        assert!(!party.members[0].on_phone);
        assert!(party.members[1].on_phone);
    }

    fn name(raw: &str) -> CheckedName {
        crate::profiles::check_name(raw).unwrap()
    }

    fn star() -> Avatar {
        Avatar::BuiltIn {
            key: AvatarKey::Star,
        }
    }

    #[test]
    fn a_new_guest_enters_with_its_name_free_colour_and_avatar_on_medium() {
        let mut party = party();
        join_phone(&mut party, phone(1), ProfileId(1), Sky).unwrap();
        let joined = join_guest(&mut party, phone(2), &name("  Kim "), Cherry, star()).unwrap();
        assert_eq!(
            joined,
            Joined {
                member_id: PartyMemberId(2),
                new_member: true
            }
        );
        let guest = &party.members[1];
        assert_eq!(
            guest.identity,
            Identity::Guest {
                name: "Kim".into(),
                avatar: star(),
                difficulty: Difficulty::Medium,
            }
        );
        assert_eq!(guest.colour, Cherry);
        assert!(!guest.favourite_taken);
        assert!(guest.on_phone);
        assert_eq!(party.phones[1].member_id, PartyMemberId(2));
    }

    #[test]
    fn a_guest_must_pick_a_free_colour_but_may_share_an_avatar() {
        let mut party = party();
        join_guest(&mut party, phone(1), &name("Kim"), Lime, star()).unwrap();
        let before = party.clone();
        assert_eq!(
            join_guest(&mut party, phone(2), &name("Lou"), Lime, star()),
            Err(UserMessage::ColourTaken)
        );
        assert_eq!(party, before);
        join_guest(&mut party, phone(2), &name("Lou"), Mint, star()).unwrap();
        assert_eq!(colours(&party), vec![Lime, Mint]);
    }

    #[test]
    fn guest_names_are_unique_in_the_party_ignoring_case_and_spaces() {
        let mut party = party();
        join_guest(&mut party, phone(1), &name("Kim"), Lime, star()).unwrap();
        let before = party.clone();
        assert_eq!(
            join_guest(&mut party, phone(2), &name(" kIM  "), Mint, star()),
            Err(UserMessage::NameTakenTonight {
                member_id: PartyMemberId(1)
            })
        );
        assert_eq!(party, before);
        assert_eq!(
            guest_named(&party, &name("KIM").key, None),
            Some(PartyMemberId(1))
        );
        assert_eq!(
            guest_named(&party, &name("KIM").key, Some(PartyMemberId(1))),
            None
        );
    }

    #[test]
    fn with_twelve_colours_held_a_new_guest_is_refused_as_full() {
        let mut party = full_party();
        let before = party.clone();
        assert!(is_full(&party));
        assert_eq!(
            join_guest(&mut party, phone(13), &name("Kim"), Cherry, star()),
            Err(UserMessage::PartyFull)
        );
        assert_eq!(party, before);
    }

    #[test]
    fn switching_from_a_guest_keeps_the_guest_in_the_party_with_its_colour() {
        let mut party = party();
        join_guest(&mut party, phone(1), &name("Kim"), Teal, star()).unwrap();
        join_phone(&mut party, phone(1), ProfileId(1), Teal).unwrap();
        assert_eq!(colours(&party), vec![Teal, Cherry]);
        assert_eq!(party.phones.len(), 1);
        assert_eq!(party.phones[0].member_id, PartyMemberId(2));
        assert!(!party.members[0].on_phone);
        // Two Guests with one name never exist, even one off its Phone.
        assert_eq!(
            join_guest(&mut party, phone(2), &name("kim"), Lime, star()),
            Err(UserMessage::NameTakenTonight {
                member_id: PartyMemberId(1)
            })
        );
    }

    #[test]
    fn editing_a_colour_in_the_party_accepts_only_free_colours() {
        let mut party = party();
        join_phone(&mut party, phone(1), ProfileId(1), Navy).unwrap();
        join_phone(&mut party, phone(2), ProfileId(2), Navy).unwrap();
        join_guest(&mut party, phone(3), &name("Kim"), Lime, star()).unwrap();
        assert!(party.members[1].favourite_taken);
        let before = party.clone();
        let colour = |colour| MemberEdit {
            colour: Some(colour),
            ..MemberEdit::default()
        };
        assert_eq!(
            edit_member(&mut party, PartyMemberId(3), None, &colour(Navy)),
            Err(UserMessage::ColourTaken)
        );
        assert_eq!(
            edit_member(&mut party, PartyMemberId(9), None, &colour(Mint)),
            Err(UserMessage::MemberNotFound)
        );
        assert_eq!(party, before);
        // Its own colour is no change; a free one is taken at once.
        edit_member(&mut party, PartyMemberId(3), None, &colour(Lime)).unwrap();
        edit_member(&mut party, PartyMemberId(3), None, &colour(Mint)).unwrap();
        // A Profile that picks a colour holds it as its favourite now.
        edit_member(&mut party, PartyMemberId(2), None, &colour(Lime)).unwrap();
        assert_eq!(colours(&party), vec![Navy, Lime, Mint]);
        assert!(!party.members[1].favourite_taken);
    }

    #[test]
    fn a_guest_edit_changes_its_name_and_avatar_and_keeps_names_unique() {
        let mut party = party();
        join_guest(&mut party, phone(1), &name("Kim"), Lime, star()).unwrap();
        join_guest(&mut party, phone(2), &name("Lou"), Mint, star()).unwrap();
        join_phone(&mut party, phone(3), ProfileId(1), Sky).unwrap();
        let moon = Avatar::BuiltIn {
            key: AvatarKey::Moon,
        };
        let edit = MemberEdit {
            avatar: Some(moon),
            ..MemberEdit::default()
        };
        edit_member(&mut party, PartyMemberId(2), Some(&name(" LOU2 ")), &edit).unwrap();
        assert_eq!(
            party.members[1].identity,
            Identity::Guest {
                name: "LOU2".into(),
                avatar: moon,
                difficulty: Difficulty::Medium,
            }
        );
        // A rename may keep its own name in another case.
        edit_member(
            &mut party,
            PartyMemberId(2),
            Some(&name("lou2")),
            &MemberEdit::default(),
        )
        .unwrap();
        let before = party.clone();
        assert_eq!(
            edit_member(
                &mut party,
                PartyMemberId(2),
                Some(&name("kim")),
                &MemberEdit::default()
            ),
            Err(UserMessage::NameTakenTonight {
                member_id: PartyMemberId(1)
            })
        );
        // A Profile renamed to a Guest's name is refused the same way.
        assert_eq!(
            edit_member(
                &mut party,
                PartyMemberId(3),
                Some(&name("KIM")),
                &MemberEdit::default()
            ),
            Err(UserMessage::NameTakenTonight {
                member_id: PartyMemberId(1)
            })
        );
        assert_eq!(party, before);
    }

    fn request(id: u32, players: &[u32], adder: Option<u32>) -> Request {
        Request {
            request_id: RequestId(id),
            kind: RequestKind::Song,
            song_id: SongId(id),
            requested_players: players.iter().copied().map(PartyMemberId).collect(),
            adder: adder.map(PartyMemberId),
        }
    }

    #[test]
    fn a_member_who_leaves_frees_its_colour_and_takes_every_phone_on_it_out() {
        let mut party = party();
        join_phone(&mut party, phone(1), ProfileId(1), Teal).unwrap();
        join_guest(&mut party, phone(2), &name("Lukas"), Tangerine, star()).unwrap();
        join_phone(&mut party, phone(3), ProfileId(1), Teal).unwrap();
        let left = leave(&mut party, PartyMemberId(1)).unwrap();
        assert_eq!(left.member.colour, Teal);
        assert_eq!(left.phones, vec![phone(1), phone(3)]);
        assert_eq!(colours(&party), vec![Tangerine]);
        assert_eq!(party.phones.len(), 1);
        assert_eq!(party.phones[0].phone_id, phone(2));
        // The freed colour goes to the next member who enters.
        join_guest(&mut party, phone(4), &name("Mia"), Teal, star()).unwrap();
        assert_eq!(colours(&party), vec![Tangerine, Teal]);
    }

    #[test]
    fn a_member_who_leaves_is_dropped_from_every_request() {
        let mut party = party();
        for n in 1..=3 {
            join_phone(&mut party, phone(n), ProfileId(n), Teal).unwrap();
        }
        party.queue = vec![
            request(10, &[1, 2], Some(2)),
            request(11, &[2], None),
            request(12, &[3, 2, 1], Some(1)),
        ];
        party.head = Some(RequestId(10));
        leave(&mut party, PartyMemberId(2)).unwrap();
        // A Request the member added stays, still naming who added it (the
        // Remotes show no adder for a member no longer in the Party; it is
        // never shown as the Stage's).
        assert_eq!(
            party.queue,
            vec![
                request(10, &[1], Some(2)),
                request(11, &[], None),
                request(12, &[3, 1], Some(1)),
            ]
        );
        assert_eq!(party.head, Some(RequestId(10)));
    }

    #[test]
    fn a_new_member_never_takes_the_id_of_an_adder_who_left() {
        let mut party = party();
        for n in 1..=2 {
            join_phone(&mut party, phone(n), ProfileId(n), Teal).unwrap();
        }
        party.queue = vec![request(10, &[], Some(2))];
        leave(&mut party, PartyMemberId(2)).unwrap();
        let joined = join_phone(&mut party, phone(3), ProfileId(3), Teal).unwrap();
        assert_eq!(joined.member_id, PartyMemberId(3));
    }

    fn seat(member: u32, phone_id: Option<PhoneId>) -> Seat {
        Seat {
            member_id: PartyMemberId(member),
            mic: phone_id.map(|p| MicKey::Phone { phone_id: p.0 }),
            voice: SeatVoice::P1,
            difficulty: Difficulty::Medium,
        }
    }

    fn line_up(seats: Vec<Seat>) -> LineUp {
        LineUp {
            request_id: RequestId(10),
            duet: false,
            seats,
            can_start: false,
            warnings: Vec::new(),
        }
    }

    #[test]
    fn a_seated_member_cannot_leave_and_nothing_changes() {
        let mut party = party();
        join_phone(&mut party, phone(1), ProfileId(1), Teal).unwrap();
        party.queue = vec![request(10, &[1], None)];
        party.head = Some(RequestId(10));
        party.line_up = Some(line_up(vec![seat(1, Some(phone(1)))]));
        let before = party.clone();
        assert_eq!(
            leave(&mut party, PartyMemberId(1)).unwrap_err(),
            UserMessage::MemberSinging
        );
        assert_eq!(party, before);
        assert_eq!(
            leave(&mut party, PartyMemberId(7)).unwrap_err(),
            UserMessage::MemberNotFound
        );
        assert_eq!(party, before);
    }

    #[test]
    fn a_phone_that_leaves_is_no_longer_any_seats_mic() {
        let mut party = party();
        join_phone(&mut party, phone(1), ProfileId(1), Teal).unwrap();
        join_phone(&mut party, phone(2), ProfileId(2), Lime).unwrap();
        party.queue = vec![request(10, &[1], None)];
        party.head = Some(RequestId(10));
        // Member 1 sings on member 2's Phone.
        party.line_up = Some(line_up(vec![seat(1, Some(phone(2)))]));
        leave(&mut party, PartyMemberId(2)).unwrap();
        assert_eq!(party.line_up, Some(line_up(vec![seat(1, None)])));
    }

    #[test]
    fn during_a_song_a_member_whose_phone_is_a_seats_mic_cannot_leave() {
        let mut party = party();
        join_phone(&mut party, phone(1), ProfileId(1), Teal).unwrap();
        join_phone(&mut party, phone(2), ProfileId(2), Lime).unwrap();
        party.queue = vec![request(10, &[1], None)];
        party.head = Some(RequestId(10));
        party.line_up = Some(line_up(vec![seat(1, Some(phone(2)))]));
        party.playing = Some(openstar_protocol::PlayingSong {
            request_id: RequestId(10),
            song_id: openstar_protocol::library::SongId(10),
            paused: false,
        });
        let before = party.clone();
        assert_eq!(
            leave(&mut party, PartyMemberId(2)).unwrap_err(),
            UserMessage::MemberSinging
        );
        assert_eq!(party, before);
    }

    #[test]
    fn a_deleted_profile_leaves_the_party_and_its_waiting_seat() {
        let mut party = party();
        join_phone(&mut party, phone(1), ProfileId(1), Teal).unwrap();
        join_phone(&mut party, phone(2), ProfileId(2), Lime).unwrap();
        party.queue = vec![request(10, &[1, 2], Some(1))];
        party.head = Some(RequestId(10));
        party.line_up = Some(line_up(vec![
            seat(1, Some(phone(1))),
            seat(2, Some(phone(1))),
        ]));

        let left = delete_profile(&mut party, ProfileId(1)).unwrap().unwrap();

        assert_eq!(left.member.colour, Teal);
        assert_eq!(left.phones, vec![phone(1)]);
        assert_eq!(colours(&party), vec![Lime]);
        // Its seat is gone, and its Phone is no other seat's Mic.
        assert_eq!(party.line_up, Some(line_up(vec![seat(2, None)])));
        assert_eq!(party.queue, vec![request(10, &[2], Some(1))]);
        // A Profile that is no member changes nothing.
        let before = party.clone();
        assert_eq!(delete_profile(&mut party, ProfileId(9)), Ok(None));
        assert_eq!(party, before);
    }

    #[test]
    fn a_profile_that_sings_in_the_playing_song_cannot_be_deleted() {
        let playing = |party: &mut PartySnapshot| {
            party.playing = Some(openstar_protocol::PlayingSong {
                request_id: RequestId(10),
                song_id: openstar_protocol::library::SongId(10),
                paused: false,
            });
        };
        let mut party = party();
        join_phone(&mut party, phone(1), ProfileId(1), Teal).unwrap();
        join_phone(&mut party, phone(2), ProfileId(2), Lime).unwrap();
        join_phone(&mut party, phone(3), ProfileId(3), Mint).unwrap();
        party.queue = vec![request(10, &[1], None)];
        party.head = Some(RequestId(10));
        // Member 1 sings on member 2's Phone.
        party.line_up = Some(line_up(vec![seat(1, Some(phone(2)))]));
        playing(&mut party);
        let before = party.clone();
        for profile in [1, 2] {
            assert_eq!(
                delete_profile(&mut party, ProfileId(profile)),
                Err(UserMessage::ProfileSinging)
            );
            assert_eq!(party, before);
        }
        // Member 3 does not sing: it goes.
        assert!(delete_profile(&mut party, ProfileId(3)).unwrap().is_some());
        assert_eq!(colours(&party), vec![Teal, Lime]);
    }

    #[derive(Debug, Clone)]
    enum Step {
        Join { phone: u32, profile: u32 },
        Leave { member: u32 },
        NewParty,
    }

    fn step() -> impl Strategy<Value = Step> {
        prop_oneof![
            8 => (0..20_u32, 0..18_u32).prop_map(|(phone, profile)| Step::Join { phone, profile }),
            3 => (1..20_u32).prop_map(|member| Step::Leave { member }),
            1 => Just(Step::NewParty),
        ]
    }

    proptest! {
        #[test]
        fn no_two_members_ever_share_a_colour_and_no_favourite_changes(
            favourites in proptest::collection::vec(0..12_usize, 18),
            steps in proptest::collection::vec(step(), 0..80),
        ) {
            let favourites: Vec<PaletteKey> =
                favourites.into_iter().map(|i| PaletteKey::ALL[i]).collect();
            let kept = favourites.clone();
            let mut party = party();
            for step in steps {
                match step {
                    Step::Join { phone: n, profile } => {
                        let favourite = favourites[profile as usize];
                        let id = ProfileId(profile);
                        let was_member = party.members.iter().any(|m| {
                            m.identity == Identity::Profile { profile_id: id }
                        });
                        let held = colours(&party);
                        match join_phone(&mut party, phone(n), id, favourite) {
                            Ok(joined) => {
                                prop_assert_eq!(joined.new_member, !was_member);
                                if !was_member {
                                    let colour = party.members.last().unwrap().colour;
                                    let expected = if held.contains(&favourite) {
                                        *PaletteKey::ALL.iter().find(|c| !held.contains(c)).unwrap()
                                    } else {
                                        favourite
                                    };
                                    prop_assert_eq!(colour, expected);
                                }
                            }
                            Err(refusal) => {
                                prop_assert_eq!(refusal, UserMessage::PartyFull);
                                prop_assert!(!was_member);
                                prop_assert_eq!(held.len(), 12);
                            }
                        }
                    }
                    Step::Leave { member } => {
                        let id = PartyMemberId(member);
                        let was_member = party.members.iter().any(|m| m.member_id == id);
                        match leave(&mut party, id) {
                            Ok(left) => {
                                prop_assert!(was_member);
                                prop_assert!(party.members.iter().all(|m| m.member_id != id));
                                prop_assert!(party.phones.iter().all(|p| p.member_id != id));
                                prop_assert!(colour_holder(&party, left.member.colour).is_none());
                            }
                            Err(refusal) => {
                                prop_assert_eq!(refusal, UserMessage::MemberNotFound);
                                prop_assert!(!was_member);
                            }
                        }
                    }
                    Step::NewParty => {
                        party = start_party(&party.stage_id, Some(&party), 2).unwrap();
                        prop_assert!(party.members.is_empty() && party.phones.is_empty());
                    }
                }
                let held = colours(&party);
                let distinct: std::collections::HashSet<_> = held.iter().collect();
                prop_assert_eq!(distinct.len(), held.len());
                prop_assert!(held.len() <= 12);
                prop_assert_eq!(&favourites, &kept);
            }
        }
    }

    fn is_four_digits(code: &JoinCode) -> bool {
        code.0.len() == 4 && code.0.chars().all(|c| c.is_ascii_digit())
    }

    #[test]
    fn a_join_code_is_four_random_digits() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..2_000 {
            let code = draw_join_code(None).unwrap();
            assert!(is_four_digits(&code), "{code:?}");
            seen.insert(code);
        }
        // 2 000 draws from 10 000 codes: far more than a handful are distinct.
        assert!(seen.len() > 1_500, "only {} distinct codes", seen.len());
    }

    #[test]
    fn a_new_partys_code_never_equals_the_previous_partys() {
        let mut previous = draw_join_code(None).unwrap();
        for _ in 0..20_000 {
            let next = draw_join_code(Some(&previous)).unwrap();
            assert!(is_four_digits(&next));
            assert_ne!(next, previous);
            previous = next;
        }
    }

    #[test]
    fn a_draw_that_hits_the_previous_code_draws_again() {
        // A source that first yields the previous code (0427), then 1234.
        let mut values = [427_u16, 1234].into_iter();
        let code = draw_join_code_from(Some(&JoinCode("0427".into())), || {
            Ok(values.next().unwrap())
        })
        .unwrap();
        assert_eq!(code, JoinCode("1234".into()));
    }

    #[test]
    fn leading_zeros_are_kept() {
        let code = draw_join_code_from(None, || Ok(7)).unwrap();
        assert_eq!(code, JoinCode("0007".into()));
    }

    #[test]
    fn every_new_party_has_a_new_id_and_the_given_stage_and_time() {
        let stage = StageId("main".into());
        let first = start_party(&stage, None, 1_000).unwrap();
        let second = start_party(&stage, Some(&first), 2_000).unwrap();
        assert_ne!(first.party_id, second.party_id);
        assert_ne!(first.join_code, second.join_code);
        assert_eq!(second.stage_id, stage);
        assert_eq!(second.started_at_ms, 2_000);
    }
}
