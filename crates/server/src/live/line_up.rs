//! The Line-up's own rules, free of the task and the database: how a
//! Request's Line-up is prefilled when it reaches the head, when Start may
//! be pressed, and which warnings the screens show.

use std::collections::{HashMap, HashSet};

use openstar_protocol::mics::MicKey;
use openstar_protocol::profile::{Difficulty, ProfileId};
use openstar_protocol::{
    Identity, LineUp, LineUpWarning, PartyMember, PartyMemberId, PartySnapshot, PhoneId, Request,
    SEATS, Seat, SeatVoice,
};

/// What the Mic prefill chooses from, besides the Party's joined Phones.
#[derive(Debug, Default)]
pub struct MicChoices {
    /// The Local mics that are switched on and present, in Mics-screen order.
    pub local_mics: Vec<String>,
    /// The Local mic each Party member last sang on in this Party.
    pub last_local_mics: HashMap<PartyMemberId, String>,
}

/// The Line-up of `request` as it reaches the head of `party`'s Queue: one
/// seat per requested Player, in the Request's order, up to [`SEATS`].
/// Requested Players no longer in the Party are skipped.
pub fn prefill(
    party: &PartySnapshot,
    request: &Request,
    duet: bool,
    last_difficulties: &HashMap<ProfileId, Difficulty>,
    mics: &MicChoices,
) -> LineUp {
    let mut taken: Vec<MicKey> = Vec::new();
    let seats = request
        .requested_players
        .iter()
        .filter_map(|id| party.members.iter().find(|m| m.member_id == *id))
        .take(SEATS)
        .enumerate()
        .map(|(index, member)| Seat {
            member_id: member.member_id,
            mic: prefill_mic(party, member.member_id, mics, &mut taken),
            voice: if duet && index % 2 == 1 {
                SeatVoice::P2
            } else {
                SeatVoice::P1
            },
            difficulty: starting_difficulty(member, last_difficulties),
        })
        .collect();
    LineUp {
        request_id: request.request_id,
        duet,
        seats,
        can_start: false,
        warnings: Vec::new(),
    }
}

/// The Mic prefilled into `member`'s seat, in this order: the Local mic the
/// member last sang on in this Party if it is free, else the first free
/// Local mic in Mics-screen order, else the member's own joined Phone, else
/// none. A Mic already in `taken` is not free; the chosen one is added.
fn prefill_mic(
    party: &PartySnapshot,
    member: PartyMemberId,
    mics: &MicChoices,
    taken: &mut Vec<MicKey>,
) -> Option<MicKey> {
    let local = |id: &String| MicKey::LocalMic {
        local_mic_id: id.clone(),
    };
    let last = mics
        .last_local_mics
        .get(&member)
        .filter(|id| mics.local_mics.contains(id))
        .map(local);
    let free_local = mics.local_mics.iter().map(local);
    let own_phones = party
        .phones
        .iter()
        .filter(|phone| phone.member_id == member)
        .map(|phone| MicKey::Phone {
            phone_id: phone.phone_id.0.clone(),
        });
    let mic = last
        .into_iter()
        .chain(free_local)
        .chain(own_phones)
        .find(|mic| !taken.contains(mic))?;
    taken.push(mic.clone());
    Some(mic)
}

/// The Difficulty a member's seat starts at: a Profile's last Difficulty
/// (Medium when it has never sung), or a Guest's Party Difficulty.
pub fn starting_difficulty(
    member: &PartyMember,
    last_difficulties: &HashMap<ProfileId, Difficulty>,
) -> Difficulty {
    match &member.identity {
        Identity::Profile { profile_id } => last_difficulties
            .get(profile_id)
            .copied()
            .unwrap_or_default(),
        Identity::Guest { difficulty, .. } => *difficulty,
    }
}

/// Sets whether `line_up` can start and which warnings it shows, given
/// the Phones that reported their mic could not open.
///
/// Start needs at least one seat, a Mic in every seat, no Mic in two seats,
/// no member in two seats ("at most once" is this rule, never a database
/// constraint), and in a duet someone on each Voice. A blocked Phone mic
/// warns but never blocks Start. An empty Line-up shows no warning: its
/// screens offer Add a singer instead.
pub fn check(line_up: &mut LineUp, blocked_phones: &HashSet<PhoneId>) {
    let mut warnings = Vec::new();
    for seat in &line_up.seats {
        match &seat.mic {
            None => warnings.push(LineUpWarning::NoMic {
                member_id: seat.member_id,
            }),
            Some(MicKey::Phone { phone_id })
                if blocked_phones.contains(&PhoneId(phone_id.clone())) =>
            {
                warnings.push(LineUpWarning::MicBlocked {
                    member_id: seat.member_id,
                });
            }
            Some(_) => {}
        }
    }
    let missing_voices: Vec<SeatVoice> = if line_up.duet && !line_up.seats.is_empty() {
        [SeatVoice::P1, SeatVoice::P2]
            .into_iter()
            .filter(|voice| !line_up.seats.iter().any(|seat| seat.voice == *voice))
            .collect()
    } else {
        Vec::new()
    };
    let seats = &line_up.seats;
    let twice = |same: &dyn Fn(&Seat, &Seat) -> bool| {
        seats
            .iter()
            .enumerate()
            .any(|(index, seat)| seats[..index].iter().any(|earlier| same(earlier, seat)))
    };
    line_up.can_start = !seats.is_empty()
        && seats.iter().all(|seat| seat.mic.is_some())
        && !twice(&|a, b| a.mic == b.mic)
        && !twice(&|a, b| a.member_id == b.member_id)
        && missing_voices.is_empty();
    warnings.extend(
        missing_voices
            .into_iter()
            .map(|voice| LineUpWarning::DuetNeedsVoice { voice }),
    );
    line_up.warnings = warnings;
}

#[cfg(test)]
mod tests {
    use super::*;
    use openstar_protocol::library::SongId;
    use openstar_protocol::profile::{Avatar, AvatarKey, PaletteKey};
    use openstar_protocol::{JoinedPhone, RequestId, RequestKind, StageId};

    fn member(n: u32) -> PartyMemberId {
        PartyMemberId(n)
    }

    /// A Party with Profile members 1..=profiles (Profile id = member id),
    /// then one Guest per entry of `guests`, each with that Difficulty.
    fn party(profiles: u32, guests: &[Difficulty]) -> PartySnapshot {
        let mut party = super::super::party::start_party(&StageId("main".into()), None, 1).unwrap();
        for n in 1..=profiles {
            party.members.push(PartyMember {
                member_id: member(n),
                identity: Identity::Profile {
                    profile_id: ProfileId(n),
                },
                colour: PaletteKey::ALL[n as usize - 1],
                favourite_taken: false,
                on_phone: false,
            });
        }
        for (index, difficulty) in guests.iter().enumerate() {
            let n = profiles + 1 + index as u32;
            party.members.push(PartyMember {
                member_id: member(n),
                identity: Identity::Guest {
                    name: format!("Guest {n}"),
                    avatar: Avatar::BuiltIn {
                        key: AvatarKey::Star,
                    },
                    difficulty: *difficulty,
                },
                colour: PaletteKey::ALL[n as usize - 1],
                favourite_taken: false,
                on_phone: false,
            });
        }
        party
    }

    fn join_phone(party: &mut PartySnapshot, phone: &str, n: u32) {
        party.phones.push(JoinedPhone {
            phone_id: PhoneId(phone.into()),
            member_id: member(n),
        });
    }

    fn request(players: &[u32]) -> Request {
        Request {
            request_id: RequestId(9),
            kind: RequestKind::Song,
            song_id: SongId(1),
            requested_players: players.iter().copied().map(member).collect(),
            adder: None,
        }
    }

    fn solo(party: &PartySnapshot, players: &[u32]) -> LineUp {
        prefill(
            party,
            &request(players),
            false,
            &HashMap::new(),
            &MicChoices::default(),
        )
    }

    fn who(line_up: &LineUp) -> Vec<u32> {
        line_up.seats.iter().map(|seat| seat.member_id.0).collect()
    }

    #[test]
    fn one_seat_per_requested_player_in_the_requests_order() {
        let party = party(3, &[]);
        let line_up = solo(&party, &[3, 1, 2]);
        assert_eq!(line_up.request_id, RequestId(9));
        assert_eq!(who(&line_up), vec![3, 1, 2]);
    }

    #[test]
    fn seats_are_cut_off_at_the_seat_count() {
        let party = party(6, &[]);
        let line_up = solo(&party, &[6, 5, 4, 3, 2, 1]);
        assert_eq!(line_up.seats.len(), SEATS);
        assert_eq!(who(&line_up), [6, 5, 4, 3, 2, 1][..SEATS].to_vec());
    }

    #[test]
    fn a_request_with_no_requested_players_gives_an_empty_line_up() {
        let party = party(2, &[]);
        assert!(solo(&party, &[]).seats.is_empty());
    }

    #[test]
    fn a_one_voice_song_puts_every_seat_on_voice_1() {
        let party = party(3, &[]);
        let voices: Vec<SeatVoice> = solo(&party, &[1, 2, 3])
            .seats
            .iter()
            .map(|seat| seat.voice)
            .collect();
        assert_eq!(voices, vec![SeatVoice::P1; 3]);
    }

    #[test]
    fn a_duet_alternates_voice_1_and_voice_2_in_seat_order() {
        let party = party(3, &[]);
        let line_up = prefill(
            &party,
            &request(&[3, 1, 2]),
            true,
            &HashMap::new(),
            &MicChoices::default(),
        );
        assert!(line_up.duet);
        let voices: Vec<SeatVoice> = line_up.seats.iter().map(|seat| seat.voice).collect();
        assert_eq!(voices, vec![SeatVoice::P1, SeatVoice::P2, SeatVoice::P1]);
    }

    #[test]
    fn each_seat_starts_at_the_members_difficulty() {
        // Profiles 1 and 2 (1 last sang on Hard, 2 never sang), then a Guest on
        // Easy and a Guest still on Medium.
        let party = party(2, &[Difficulty::Easy, Difficulty::Medium]);
        let last = HashMap::from([(ProfileId(1), Difficulty::Hard)]);
        let line_up = prefill(
            &party,
            &request(&[1, 2, 3, 4]),
            false,
            &last,
            &MicChoices::default(),
        );
        let difficulties: Vec<Difficulty> =
            line_up.seats.iter().map(|seat| seat.difficulty).collect();
        assert_eq!(
            difficulties,
            vec![
                Difficulty::Hard,
                Difficulty::Medium,
                Difficulty::Easy,
                Difficulty::Medium
            ]
        );
    }

    fn local(id: &str) -> Option<MicKey> {
        Some(MicKey::LocalMic {
            local_mic_id: id.into(),
        })
    }

    fn phone(id: &str) -> Option<MicKey> {
        Some(MicKey::Phone {
            phone_id: id.into(),
        })
    }

    fn mics_of(party: &PartySnapshot, players: &[u32], mics: &MicChoices) -> Vec<Option<MicKey>> {
        prefill(party, &request(players), false, &HashMap::new(), mics)
            .seats
            .into_iter()
            .map(|seat| seat.mic)
            .collect()
    }

    #[test]
    fn the_local_mic_a_member_last_sang_on_this_party_comes_first_when_free() {
        let mut party = party(2, &[]);
        join_phone(&mut party, "phone-1", 1);
        let mics = MicChoices {
            local_mics: vec!["red".into(), "blue".into()],
            last_local_mics: HashMap::from([(member(1), "blue".into())]),
        };
        assert_eq!(
            mics_of(&party, &[1, 2], &mics),
            vec![local("blue"), local("red")]
        );
    }

    #[test]
    fn a_last_local_mic_that_is_not_free_is_passed_over() {
        let party = party(2, &[]);
        // Member 2 last sang on "red", but member 1's seat comes first and
        // takes it as the first free Local mic; "green" is not switched on
        // or not present.
        let mics = MicChoices {
            local_mics: vec!["red".into(), "blue".into()],
            last_local_mics: HashMap::from([
                (member(2), "red".into()),
                (member(1), "green".into()),
            ]),
        };
        assert_eq!(
            mics_of(&party, &[1, 2], &mics),
            vec![local("red"), local("blue")]
        );
    }

    #[test]
    fn free_local_mics_go_in_mics_screen_order_before_any_phone() {
        let mut party = party(3, &[]);
        join_phone(&mut party, "phone-1", 1);
        join_phone(&mut party, "phone-2", 2);
        let mics = MicChoices {
            local_mics: vec!["red".into()],
            last_local_mics: HashMap::new(),
        };
        assert_eq!(
            mics_of(&party, &[1, 2, 3], &mics),
            vec![local("red"), phone("phone-2"), None]
        );
    }

    #[test]
    fn a_member_without_a_free_local_mic_or_a_phone_has_no_mic() {
        let mut party = party(2, &[]);
        join_phone(&mut party, "phone-1", 1);
        assert_eq!(
            mics_of(&party, &[2, 1], &MicChoices::default()),
            vec![None, phone("phone-1")]
        );
    }

    #[test]
    fn a_mic_is_never_prefilled_into_two_seats() {
        // Both members last sang on "red"; a Phone of member 1 that member 2
        // also used is not member 2's own.
        let mut party = party(2, &[]);
        join_phone(&mut party, "phone-1", 1);
        let mics = MicChoices {
            local_mics: vec!["red".into()],
            last_local_mics: HashMap::from([(member(1), "red".into()), (member(2), "red".into())]),
        };
        assert_eq!(mics_of(&party, &[1, 2], &mics), vec![local("red"), None]);
    }

    fn seat(n: u32, mic: Option<MicKey>, voice: SeatVoice) -> Seat {
        Seat {
            member_id: member(n),
            mic,
            voice,
            difficulty: Difficulty::Medium,
        }
    }

    fn checked(duet: bool, seats: Vec<Seat>, blocked: &[&str]) -> LineUp {
        let mut line_up = LineUp {
            request_id: RequestId(9),
            duet,
            seats,
            can_start: true,
            warnings: vec![LineUpWarning::NoMic {
                member_id: member(99),
            }],
        };
        let blocked: HashSet<PhoneId> = blocked.iter().map(|id| PhoneId((*id).into())).collect();
        check(&mut line_up, &blocked);
        line_up
    }

    #[test]
    fn a_full_line_up_with_a_mic_per_seat_can_start() {
        let line_up = checked(
            false,
            vec![
                seat(1, local("red"), SeatVoice::P1),
                seat(2, phone("phone-2"), SeatVoice::P1),
            ],
            &[],
        );
        assert!(line_up.can_start);
        assert_eq!(line_up.warnings, vec![]);
    }

    #[test]
    fn an_empty_line_up_cannot_start() {
        let line_up = checked(false, Vec::new(), &[]);
        assert!(!line_up.can_start);
        assert_eq!(line_up.warnings, vec![]);
    }

    #[test]
    fn a_seat_without_a_mic_blocks_start_and_warns() {
        let line_up = checked(
            false,
            vec![
                seat(1, local("red"), SeatVoice::P1),
                seat(2, None, SeatVoice::P1),
            ],
            &[],
        );
        assert!(!line_up.can_start);
        assert_eq!(
            line_up.warnings,
            vec![LineUpWarning::NoMic {
                member_id: member(2)
            }]
        );
    }

    #[test]
    fn one_mic_in_two_seats_blocks_start() {
        let line_up = checked(
            false,
            vec![
                seat(1, local("red"), SeatVoice::P1),
                seat(2, local("red"), SeatVoice::P1),
            ],
            &[],
        );
        assert!(!line_up.can_start);
    }

    #[test]
    fn one_member_in_two_seats_blocks_start() {
        let line_up = checked(
            false,
            vec![
                seat(1, local("red"), SeatVoice::P1),
                seat(1, local("blue"), SeatVoice::P1),
            ],
            &[],
        );
        assert!(!line_up.can_start);
    }

    #[test]
    fn a_duet_needs_someone_on_each_voice() {
        let nobody_on_2 = checked(
            true,
            vec![
                seat(1, local("red"), SeatVoice::P1),
                seat(2, local("blue"), SeatVoice::P1),
            ],
            &[],
        );
        assert!(!nobody_on_2.can_start);
        assert_eq!(
            nobody_on_2.warnings,
            vec![LineUpWarning::DuetNeedsVoice {
                voice: SeatVoice::P2
            }]
        );
        let nobody_on_1 = checked(true, vec![seat(1, local("red"), SeatVoice::P2)], &[]);
        assert_eq!(
            nobody_on_1.warnings,
            vec![LineUpWarning::DuetNeedsVoice {
                voice: SeatVoice::P1
            }]
        );
        let both = checked(
            true,
            vec![
                seat(1, local("red"), SeatVoice::P1),
                seat(2, local("blue"), SeatVoice::P2),
            ],
            &[],
        );
        assert!(both.can_start);
    }

    #[test]
    fn an_empty_duet_line_up_warns_only_that_it_is_empty_by_not_starting() {
        let line_up = checked(true, Vec::new(), &[]);
        assert!(!line_up.can_start);
        assert_eq!(line_up.warnings, vec![]);
    }

    #[test]
    fn a_seated_phone_whose_mic_is_blocked_warns_but_does_not_block_start() {
        let line_up = checked(
            false,
            vec![
                seat(1, phone("phone-1"), SeatVoice::P1),
                seat(2, phone("phone-2"), SeatVoice::P1),
            ],
            &["phone-2", "phone-3"],
        );
        assert!(line_up.can_start);
        assert_eq!(
            line_up.warnings,
            vec![LineUpWarning::MicBlocked {
                member_id: member(2)
            }]
        );
    }

    #[test]
    fn seat_warnings_come_in_seat_order_then_the_songs() {
        let line_up = checked(
            true,
            vec![
                seat(1, phone("phone-1"), SeatVoice::P1),
                seat(2, None, SeatVoice::P1),
            ],
            &["phone-1"],
        );
        assert_eq!(
            line_up.warnings,
            vec![
                LineUpWarning::MicBlocked {
                    member_id: member(1)
                },
                LineUpWarning::NoMic {
                    member_id: member(2)
                },
                LineUpWarning::DuetNeedsVoice {
                    voice: SeatVoice::P2
                },
            ]
        );
    }
}
