//! The Line-up's own rules, free of the task and the database: how a
//! Request's Line-up is prefilled when it reaches the head, how it is
//! edited while it waits, when Start may be pressed, and which warnings the
//! screens show.

use std::collections::{HashMap, HashSet};

use openstar_protocol::bridge::BridgeId;
use openstar_protocol::mics::{LocalMicSource, MicKey, PartyLocalMic};
use openstar_protocol::profile::{Difficulty, ProfileId};
use openstar_protocol::{
    Identity, LineUp, LineUpWarning, PartyMember, PartyMemberId, PartySnapshot, PhoneId, Request,
    SEATS, Seat, SeatVoice, UserMessage,
};

/// What the Mic prefill chooses from, besides the Party's joined Phones.
#[derive(Debug, Default)]
pub struct MicChoices {
    /// The Local mics that are switched on and present, in Mics-screen order.
    pub local_mics: Vec<String>,
    /// The Local mic each Party member last sang on in this Party.
    pub last_local_mics: HashMap<PartyMemberId, String>,
}

/// What the seat warnings about Local mics read: whether each switched-on
/// Local mic is present, which ones the Stage reports in digital silence,
/// and the approved Mic bridges that are closed now.
#[derive(Debug, Default, Clone)]
pub struct SeatMicState {
    /// The Party's switched-on Local mics (`PartySnapshot.local_mics`).
    pub local_mics: Vec<PartyLocalMic>,
    /// Local mics that delivered exact zeros for more than 2 s.
    pub silent: HashSet<String>,
    /// Approved Mic bridges not connected now, with their host names.
    pub closed_bridges: HashMap<BridgeId, String>,
}

impl SeatMicState {
    /// The warning, if any, for a seat of `member_id` on Local mic
    /// `local_mic_id`. Only what is certain: a closed bridge, then an
    /// unplugged Local mic, then digital silence. A Local mic that is not
    /// switched on is not listed and gets none.
    fn warning(&self, member_id: PartyMemberId, local_mic_id: &str) -> Option<LineUpWarning> {
        let mic = self
            .local_mics
            .iter()
            .find(|mic| mic.local_mic_id == local_mic_id)?;
        if let LocalMicSource::Bridge { bridge_id, .. } = &mic.source
            && let Some(host_name) = self.closed_bridges.get(bridge_id)
        {
            return Some(LineUpWarning::BridgeClosed {
                member_id,
                local_mic_id: local_mic_id.to_owned(),
                host_name: host_name.clone(),
            });
        }
        if !mic.present {
            return Some(LineUpWarning::LocalMicUnplugged {
                member_id,
                local_mic_id: local_mic_id.to_owned(),
            });
        }
        self.silent
            .contains(local_mic_id)
            .then(|| LineUpWarning::LocalMicSilent {
                member_id,
                local_mic_id: local_mic_id.to_owned(),
            })
    }
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

/// What [`seat_member`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Seated {
    /// The member sat in another seat, which was taken off.
    pub moved: bool,
}

/// Puts Party member `member_id` of `party` in `seat` of `line_up`, or in a
/// new last seat when `seat` is `None` (Add a singer, refused with
/// [`UserMessage::TooManyPlayers`] once [`SEATS`] seats are filled).
///
/// A member who sits in another seat moves: that seat is taken off and the
/// member keeps its Difficulty (and its Mic when the seat it goes to has
/// none of its own); anyone else starts at [`starting_difficulty`]. The
/// seat keeps its Voice and a Local mic; a Phone that is not the member's
/// own is replaced by the Mic prefill rule. A new seat takes the Voice the
/// prefill would give its place. Nothing changes when refused.
pub fn seat_member(
    party: &PartySnapshot,
    line_up: &mut LineUp,
    seat: Option<usize>,
    member_id: PartyMemberId,
    last_difficulties: &HashMap<ProfileId, Difficulty>,
    mics: &MicChoices,
) -> Result<Seated, UserMessage> {
    let member = party
        .members
        .iter()
        .find(|member| member.member_id == member_id)
        .ok_or(UserMessage::MemberNotFound)?;
    if let Some(index) = seat {
        let current = line_up.seats.get(index).ok_or(UserMessage::SeatNotFound)?;
        if current.member_id == member_id {
            return Ok(Seated { moved: false });
        }
    }
    let old = line_up
        .seats
        .iter()
        .position(|seated| seated.member_id == member_id);
    if seat.is_none() && old.is_none() && line_up.seats.len() >= SEATS {
        return Err(UserMessage::TooManyPlayers {
            max: u32::try_from(SEATS).unwrap_or(u32::MAX),
        });
    }
    let carried = old.map(|old| line_up.seats.remove(old));
    let difficulty = carried.as_ref().map_or_else(
        || starting_difficulty(member, last_difficulties),
        |seat| seat.difficulty,
    );
    let carried_mic = carried.and_then(|seat| seat.mic);
    let index = match (seat, old) {
        (Some(index), Some(old)) if old < index => Some(index - 1),
        (seat, _) => seat,
    };
    let own = |mic: &MicKey| match mic {
        MicKey::LocalMic { .. } => true,
        MicKey::Phone { phone_id } => party
            .phones
            .iter()
            .any(|phone| phone.phone_id.0 == *phone_id && phone.member_id == member_id),
    };
    let kept = index
        .and_then(|index| line_up.seats[index].mic.clone())
        .filter(|mic| own(mic));
    let mic = match kept.or(carried_mic) {
        Some(mic) => Some(mic),
        None => {
            let mut taken: Vec<MicKey> = line_up
                .seats
                .iter()
                .enumerate()
                .filter(|(other, _)| Some(*other) != index)
                .filter_map(|(_, seat)| seat.mic.clone())
                .collect();
            prefill_mic(party, member_id, mics, &mut taken)
        }
    };
    match index {
        Some(index) => {
            let seat = &mut line_up.seats[index];
            seat.member_id = member_id;
            seat.mic = mic;
            seat.difficulty = difficulty;
        }
        None => {
            let voice = if line_up.duet && line_up.seats.len() % 2 == 1 {
                SeatVoice::P2
            } else {
                SeatVoice::P1
            };
            line_up.seats.push(Seat {
                member_id,
                mic,
                voice,
                difficulty,
            });
        }
    }
    Ok(Seated {
        moved: old.is_some(),
    })
}

/// Sets the Mic of `seat`: a Phone joined to `party` or one of the
/// switched-on `local_mics` ([`UserMessage::MicNotAvailable`] otherwise),
/// and not the Mic of another seat ([`UserMessage::MicInUse`]).
pub fn set_mic(
    party: &PartySnapshot,
    line_up: &mut LineUp,
    seat: usize,
    mic: MicKey,
    local_mics: &[String],
) -> Result<(), UserMessage> {
    if seat >= line_up.seats.len() {
        return Err(UserMessage::SeatNotFound);
    }
    let available = match &mic {
        MicKey::Phone { phone_id } => party.phones.iter().any(|p| p.phone_id.0 == *phone_id),
        MicKey::LocalMic { local_mic_id } => local_mics.contains(local_mic_id),
    };
    if !available {
        return Err(UserMessage::MicNotAvailable);
    }
    let in_use = line_up
        .seats
        .iter()
        .enumerate()
        .any(|(other, s)| other != seat && s.mic.as_ref() == Some(&mic));
    if in_use {
        return Err(UserMessage::MicInUse);
    }
    line_up.seats[seat].mic = Some(mic);
    Ok(())
}

/// Sets the Voice of `seat`; refused with [`UserMessage::NotADuet`] for a
/// one-Voice Song.
pub fn set_voice(
    line_up: &mut LineUp,
    seat: usize,
    voice: SeatVoice,
) -> Result<&Seat, UserMessage> {
    if !line_up.duet {
        return Err(UserMessage::NotADuet);
    }
    let seat = line_up
        .seats
        .get_mut(seat)
        .ok_or(UserMessage::SeatNotFound)?;
    seat.voice = voice;
    Ok(seat)
}

/// Sets the Difficulty of `seat`.
pub fn set_difficulty(
    line_up: &mut LineUp,
    seat: usize,
    difficulty: Difficulty,
) -> Result<&Seat, UserMessage> {
    let seat = line_up
        .seats
        .get_mut(seat)
        .ok_or(UserMessage::SeatNotFound)?;
    seat.difficulty = difficulty;
    Ok(seat)
}

/// Takes the Player in `seat` off the Song: the seat goes, and the seats
/// after it move up. Returns the seat taken off.
pub fn remove_seat(line_up: &mut LineUp, seat: usize) -> Result<Seat, UserMessage> {
    if seat >= line_up.seats.len() {
        return Err(UserMessage::SeatNotFound);
    }
    Ok(line_up.seats.remove(seat))
}

/// Marks every member of `party` who sits in its waiting Line-up as
/// singing.
pub fn refresh_singing(party: &mut PartySnapshot) {
    let seated: HashSet<PartyMemberId> = party
        .line_up
        .iter()
        .flat_map(|line_up| line_up.seats.iter().map(|seat| seat.member_id))
        .collect();
    for member in &mut party.members {
        member.singing = seated.contains(&member.member_id);
    }
}

/// Sets whether `line_up` can start and which warnings it shows, given
/// the Phones that reported their mic could not open.
///
/// Start needs at least one seat, a Mic in every seat, no Mic in two seats,
/// no member in two seats ("at most once" is this rule, never a database
/// constraint), and in a duet someone on each Voice. A blocked Phone mic
/// warns but never blocks Start, nor do the Local mic warnings of `mics`
/// (unplugged, bridge closed, digital silence). An empty Line-up shows no warning: its
/// screens offer Add a singer instead.
///
/// `calibrated` holds the Mics with a Mic delay stored at the Stage's
/// current output; a seated Mic not in it is "Not calibrated", which warns
/// but never blocks Start. `None` while no output is known: no such warning.
pub fn check(
    line_up: &mut LineUp,
    blocked_phones: &HashSet<PhoneId>,
    mics: &SeatMicState,
    calibrated: Option<&HashSet<MicKey>>,
) {
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
            Some(MicKey::LocalMic { local_mic_id }) => {
                warnings.extend(mics.warning(seat.member_id, local_mic_id));
            }
            Some(_) => {}
        }
        if let (Some(mic), Some(calibrated)) = (&seat.mic, calibrated)
            && !calibrated.contains(mic)
        {
            warnings.push(LineUpWarning::NotCalibrated {
                member_id: seat.member_id,
            });
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
    use openstar_protocol::bridge::BridgeId;
    use openstar_protocol::library::SongId;
    use openstar_protocol::mics::{LocalMicSource, PartyLocalMic};
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
                singing: false,
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
                singing: false,
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
        check(&mut line_up, &blocked, &SeatMicState::default(), None);
        line_up
    }

    /// A one-seat Line-up (member 1 on Local mic `mic`) checked against `mics`.
    fn checked_mic(mic: &str, mics: &SeatMicState) -> LineUp {
        let mut line_up = LineUp {
            request_id: RequestId(9),
            duet: false,
            seats: vec![seat(1, local(mic), SeatVoice::P1)],
            can_start: false,
            warnings: Vec::new(),
        };
        check(&mut line_up, &HashSet::new(), mics, None);
        line_up
    }

    fn browser_mic(id: &str, present: bool) -> PartyLocalMic {
        PartyLocalMic {
            local_mic_id: id.into(),
            source: LocalMicSource::Browser {
                stage_browser: "stage".into(),
                device_id: "dev".into(),
                label: "USB mic".into(),
                channel: 0,
                stereo: false,
            },
            name: "Red mic".into(),
            present,
        }
    }

    fn bridge_mic(id: &str, bridge: &str, present: bool) -> PartyLocalMic {
        PartyLocalMic {
            local_mic_id: id.into(),
            source: LocalMicSource::Bridge {
                bridge_id: BridgeId(bridge.into()),
                device_name: "umc404".into(),
                label: "UMC404HD".into(),
                channel: 0,
                loopback: None,
            },
            name: String::new(),
            present,
        }
    }

    #[test]
    fn an_unplugged_local_mic_warns_under_its_seat_and_does_not_block_start() {
        let mics = SeatMicState {
            local_mics: vec![browser_mic("red", false)],
            ..SeatMicState::default()
        };
        let line_up = checked_mic("red", &mics);
        assert_eq!(
            line_up.warnings,
            vec![LineUpWarning::LocalMicUnplugged {
                member_id: member(1),
                local_mic_id: "red".into(),
            }]
        );
        assert!(line_up.can_start);
    }

    #[test]
    fn a_local_mic_of_a_closed_bridge_warns_that_the_bridge_is_closed_not_unplugged() {
        let mics = SeatMicState {
            local_mics: vec![bridge_mic("b-0", "b", false)],
            closed_bridges: HashMap::from([(BridgeId("b".into()), "hermes".into())]),
            ..SeatMicState::default()
        };
        let line_up = checked_mic("b-0", &mics);
        assert_eq!(
            line_up.warnings,
            vec![LineUpWarning::BridgeClosed {
                member_id: member(1),
                local_mic_id: "b-0".into(),
                host_name: "hermes".into(),
            }]
        );
        assert!(line_up.can_start);
    }

    #[test]
    fn a_channel_an_open_bridge_no_longer_offers_is_unplugged() {
        let mics = SeatMicState {
            local_mics: vec![bridge_mic("b-0", "b", false)],
            ..SeatMicState::default()
        };
        assert_eq!(
            checked_mic("b-0", &mics).warnings,
            vec![LineUpWarning::LocalMicUnplugged {
                member_id: member(1),
                local_mic_id: "b-0".into(),
            }]
        );
    }

    #[test]
    fn a_present_local_mic_in_digital_silence_warns_and_does_not_block_start() {
        let mics = SeatMicState {
            local_mics: vec![browser_mic("red", true)],
            silent: HashSet::from(["red".to_owned()]),
            ..SeatMicState::default()
        };
        let line_up = checked_mic("red", &mics);
        assert_eq!(
            line_up.warnings,
            vec![LineUpWarning::LocalMicSilent {
                member_id: member(1),
                local_mic_id: "red".into(),
            }]
        );
        assert!(line_up.can_start);
    }

    #[test]
    fn an_unplugged_local_mic_shows_only_unplugged_even_if_last_reported_silent() {
        let mics = SeatMicState {
            local_mics: vec![browser_mic("red", false)],
            silent: HashSet::from(["red".to_owned()]),
            ..SeatMicState::default()
        };
        assert_eq!(
            checked_mic("red", &mics).warnings,
            vec![LineUpWarning::LocalMicUnplugged {
                member_id: member(1),
                local_mic_id: "red".into(),
            }]
        );
    }

    #[test]
    fn a_present_sounding_local_mic_has_no_warning() {
        let mics = SeatMicState {
            local_mics: vec![browser_mic("red", true)],
            ..SeatMicState::default()
        };
        assert_eq!(checked_mic("red", &mics).warnings, vec![]);
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

    // Editing the waiting Line-up.

    fn waiting(duet: bool, seats: Vec<Seat>) -> LineUp {
        LineUp {
            request_id: RequestId(9),
            duet,
            seats,
            can_start: false,
            warnings: Vec::new(),
        }
    }

    fn hard(mut seat: Seat) -> Seat {
        seat.difficulty = Difficulty::Hard;
        seat
    }

    #[test]
    fn choosing_a_member_who_sits_in_another_seat_moves_them_and_empties_the_old_seat() {
        let mut party = party(3, &[]);
        join_phone(&mut party, "phone-3", 3);
        let mut line_up = waiting(
            false,
            vec![
                seat(1, local("red"), SeatVoice::P1),
                seat(2, local("blue"), SeatVoice::P1),
                hard(seat(3, phone("phone-3"), SeatVoice::P1)),
            ],
        );
        let seated = seat_member(
            &party,
            &mut line_up,
            Some(0),
            member(3),
            &HashMap::new(),
            &MicChoices::default(),
        )
        .unwrap();
        assert!(seated.moved);
        // Member 3 takes seat 0 with seat 0's Local mic and keeps its own
        // Difficulty; its old seat is gone, so the Line-up has two seats.
        assert_eq!(
            line_up.seats,
            vec![
                hard(seat(3, local("red"), SeatVoice::P1)),
                seat(2, local("blue"), SeatVoice::P1),
            ]
        );
    }

    #[test]
    fn a_new_occupant_does_not_sing_on_someone_elses_phone() {
        let mut party = party(2, &[]);
        join_phone(&mut party, "phone-1", 1);
        join_phone(&mut party, "phone-2", 2);
        let mut line_up = waiting(false, vec![seat(1, phone("phone-1"), SeatVoice::P2)]);
        let last = HashMap::from([(ProfileId(2), Difficulty::Easy)]);
        let seated = seat_member(
            &party,
            &mut line_up,
            Some(0),
            member(2),
            &last,
            &MicChoices::default(),
        )
        .unwrap();
        assert!(!seated.moved);
        assert_eq!(
            line_up.seats,
            vec![Seat {
                member_id: member(2),
                mic: phone("phone-2"),
                voice: SeatVoice::P2,
                difficulty: Difficulty::Easy,
            }]
        );
    }

    #[test]
    fn only_party_members_can_be_seated_in_a_seat_that_exists() {
        let party = party(2, &[]);
        let mut line_up = waiting(false, vec![seat(1, None, SeatVoice::P1)]);
        let mut seat_in = |seat, n| {
            seat_member(
                &party,
                &mut line_up,
                seat,
                member(n),
                &HashMap::new(),
                &MicChoices::default(),
            )
        };
        assert_eq!(seat_in(Some(0), 7), Err(UserMessage::MemberNotFound));
        assert_eq!(seat_in(Some(1), 2), Err(UserMessage::SeatNotFound));
    }

    #[test]
    fn add_a_singer_adds_a_seat_only_while_fewer_than_seats_are_filled() {
        let party = party(SEATS as u32 + 1, &[]);
        let mut line_up = waiting(true, Vec::new());
        for n in 1..=SEATS as u32 {
            let seated = seat_member(
                &party,
                &mut line_up,
                None,
                member(n),
                &HashMap::new(),
                &MicChoices::default(),
            )
            .unwrap();
            assert!(!seated.moved);
        }
        assert_eq!(who(&line_up), (1..=SEATS as u32).collect::<Vec<_>>());
        // In a duet, added seats alternate the Voices like the prefill.
        assert_eq!(line_up.seats[1].voice, SeatVoice::P2);
        let mut add = |n| {
            seat_member(
                &party,
                &mut line_up,
                None,
                member(n),
                &HashMap::new(),
                &MicChoices::default(),
            )
        };
        assert_eq!(
            add(SEATS as u32 + 1),
            Err(UserMessage::TooManyPlayers { max: SEATS as u32 })
        );
        // Adding someone already seated moves them to a new last seat.
        assert!(add(1).unwrap().moved);
        assert_eq!(
            who(&line_up),
            (2..=SEATS as u32).chain([1]).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_seats_mic_is_a_joined_phone_or_a_switched_on_local_mic_not_in_another_seat() {
        let mut party = party(2, &[]);
        join_phone(&mut party, "phone-1", 1);
        let mut line_up = waiting(
            false,
            vec![
                seat(1, None, SeatVoice::P1),
                seat(2, local("red"), SeatVoice::P1),
            ],
        );
        let switched_on = vec!["red".to_owned(), "blue".to_owned()];
        let mic = |key: Option<MicKey>| key.unwrap();
        assert_eq!(
            set_mic(&party, &mut line_up, 0, mic(local("red")), &switched_on),
            Err(UserMessage::MicInUse)
        );
        assert_eq!(
            set_mic(&party, &mut line_up, 0, mic(local("green")), &switched_on),
            Err(UserMessage::MicNotAvailable)
        );
        assert_eq!(
            set_mic(&party, &mut line_up, 0, mic(phone("phone-9")), &switched_on),
            Err(UserMessage::MicNotAvailable)
        );
        assert_eq!(
            set_mic(&party, &mut line_up, 2, mic(local("blue")), &switched_on),
            Err(UserMessage::SeatNotFound)
        );
        // Any joined Phone may serve a seat, also another member's.
        set_mic(&party, &mut line_up, 1, mic(phone("phone-1")), &switched_on).unwrap();
        set_mic(&party, &mut line_up, 0, mic(local("red")), &switched_on).unwrap();
        assert_eq!(line_up.seats[0].mic, local("red"));
        assert_eq!(line_up.seats[1].mic, phone("phone-1"));
        // Picking the Mic a seat already has changes nothing.
        set_mic(&party, &mut line_up, 0, mic(local("red")), &switched_on).unwrap();
    }

    #[test]
    fn voice_changes_only_in_a_duet() {
        let mut solo = waiting(false, vec![seat(1, None, SeatVoice::P1)]);
        assert_eq!(
            set_voice(&mut solo, 0, SeatVoice::P2),
            Err(UserMessage::NotADuet)
        );
        let mut duet = waiting(true, vec![seat(1, None, SeatVoice::P1)]);
        set_voice(&mut duet, 0, SeatVoice::P2).unwrap();
        assert_eq!(duet.seats[0].voice, SeatVoice::P2);
        assert_eq!(
            set_voice(&mut duet, 1, SeatVoice::P2),
            Err(UserMessage::SeatNotFound)
        );
    }

    #[test]
    fn taking_a_player_off_the_song_removes_the_seat() {
        let mut line_up = waiting(
            false,
            vec![seat(1, None, SeatVoice::P1), seat(2, None, SeatVoice::P1)],
        );
        assert_eq!(remove_seat(&mut line_up, 0).unwrap().member_id, member(1));
        assert_eq!(who(&line_up), vec![2]);
        assert_eq!(remove_seat(&mut line_up, 1), Err(UserMessage::SeatNotFound));
    }

    #[test]
    fn a_seated_member_is_singing_and_stays_until_taken_off_the_song() {
        let mut party = party(2, &[]);
        party.line_up = Some(waiting(
            false,
            vec![seat(1, None, SeatVoice::P1), seat(2, None, SeatVoice::P1)],
        ));
        refresh_singing(&mut party);
        assert!(party.members.iter().all(|member| member.singing));
        assert_eq!(
            super::super::party::leave(&mut party, member(1)).unwrap_err(),
            UserMessage::MemberSinging
        );

        remove_seat(party.line_up.as_mut().unwrap(), 0).unwrap();
        refresh_singing(&mut party);
        assert!(!party.members[0].singing);
        assert!(party.members[1].singing);
        super::super::party::leave(&mut party, member(1)).unwrap();
        assert_eq!(party.members.len(), 1);
    }
}
