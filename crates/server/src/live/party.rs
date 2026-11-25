//! The Party's own rules, free of the task and the database: drawing a Join
//! code and a Party id, starting a Party, and a Phone joining it as a
//! Profile with a Party colour.

use openstar_protocol::profile::{PaletteKey, ProfileId};
use openstar_protocol::{
    Identity, JoinCode, JoinedPhone, PartyId, PartyMember, PartyMemberId, PartySnapshot, PhoneId,
    StageId, UserMessage,
};

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
/// colour is `favourite`. A Profile already in the Party adds no member and
/// keeps its colour; a new one gets [`party_colour`], or is refused with
/// [`UserMessage::PartyFull`] (and nothing changes). A Phone that was joined
/// as someone else switches; that member stays in the Party.
pub fn join_phone(
    party: &mut PartySnapshot,
    phone_id: PhoneId,
    profile_id: ProfileId,
    favourite: PaletteKey,
) -> Result<Joined, UserMessage> {
    let identity = Identity::Profile { profile_id };
    let existing = party
        .members
        .iter()
        .find(|member| member.identity == identity)
        .map(|member| member.member_id);
    let joined = match existing {
        Some(member_id) => Joined {
            member_id,
            new_member: false,
        },
        None => {
            let held: Vec<PaletteKey> = party.members.iter().map(|m| m.colour).collect();
            let colour = party_colour(favourite, &held).ok_or(UserMessage::PartyFull)?;
            let member_id = next_member_id(party);
            party.members.push(PartyMember {
                member_id,
                identity,
                colour,
                favourite_taken: colour != favourite,
                on_phone: false,
            });
            Joined {
                member_id,
                new_member: true,
            }
        }
    };
    match party.phones.iter_mut().find(|p| p.phone_id == phone_id) {
        Some(phone) => phone.member_id = joined.member_id,
        None => party.phones.push(JoinedPhone {
            phone_id,
            member_id: joined.member_id,
        }),
    }
    refresh_on_phone(party);
    Ok(joined)
}

/// The id the next member to enter gets: one past the highest in use.
fn next_member_id(party: &PartySnapshot) -> PartyMemberId {
    let highest = party.members.iter().map(|m| m.member_id.0).max();
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
    use openstar_protocol::profile::PaletteKey::{self, *};
    use openstar_protocol::profile::ProfileId;
    use openstar_protocol::{Identity, PartyMemberId, PhoneId, UserMessage};
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

    #[derive(Debug, Clone)]
    enum Step {
        Join { phone: u32, profile: u32 },
        NewParty,
    }

    fn step() -> impl Strategy<Value = Step> {
        prop_oneof![
            8 => (0..20_u32, 0..18_u32).prop_map(|(phone, profile)| Step::Join { phone, profile }),
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
