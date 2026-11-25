//! The Queue's own rules, free of the task and the database: who a new
//! Request names, which requested Players are allowed, and how Requests
//! move. Every function leaves the Party unchanged when it refuses.

use openstar_protocol::{
    Actor, PartyMemberId, PartySnapshot, QueueMove, Request, RequestId, SEATS, UserMessage,
};

/// The requested Players and adder of a Request `actor` adds, from the
/// `given` list. A Phone's member is the adder, and the requested Players
/// default to that member. The Stage adds with no adder and no requested
/// Players; it may not name any.
pub fn new_request_players(
    party: &PartySnapshot,
    actor: Actor,
    given: Option<Vec<PartyMemberId>>,
) -> Result<(Vec<PartyMemberId>, Option<PartyMemberId>), UserMessage> {
    match actor {
        // The Admin area queues nothing; treated like the Stage.
        Actor::Stage | Actor::Admin => match given {
            Some(players) if !players.is_empty() => Err(UserMessage::InvalidMessage),
            _ => Ok((Vec::new(), None)),
        },
        Actor::Member { member_id } => {
            let players = given.unwrap_or_else(|| vec![member_id]);
            check_players(party, &players)?;
            Ok((players, Some(member_id)))
        }
    }
}

/// Requested Players must all be Party members, each at most once, and at
/// most [`SEATS`] of them. None at all is fine.
pub fn check_players(party: &PartySnapshot, players: &[PartyMemberId]) -> Result<(), UserMessage> {
    if players.len() > SEATS {
        return Err(UserMessage::TooManyPlayers {
            max: u32::try_from(SEATS).unwrap_or(u32::MAX),
        });
    }
    for (index, player) in players.iter().enumerate() {
        if !party.members.iter().any(|m| m.member_id == *player) {
            return Err(UserMessage::PlayerNotInParty);
        }
        if players[..index].contains(player) {
            return Err(UserMessage::PlayerTwice);
        }
    }
    Ok(())
}

/// Puts `request` at the end of the Queue. With no head while the song
/// browser shows, the first Request becomes the head; while results show,
/// the head waits for Next.
pub fn add(party: &mut PartySnapshot, request: Request) {
    party.queue.push(request);
    if party.head.is_none() && party.results.is_none() {
        party.head = party.queue.first().map(|r| r.request_id);
    }
}

/// Moves Request `id` one place up, one place down, or to directly after
/// the head. The head never moves and nothing moves above it; a move that
/// would go past either end is refused with [`UserMessage::RequestCannotMove`].
pub fn move_request(
    party: &mut PartySnapshot,
    id: RequestId,
    to: QueueMove,
) -> Result<(), UserMessage> {
    let from = position(party, id)?;
    if party.head == Some(id) {
        return Err(UserMessage::RequestCannotMove);
    }
    // The highest place a Request other than the head may take.
    let top = usize::from(party.head.is_some());
    let target = match to {
        QueueMove::Up => from.checked_sub(1).filter(|&place| place >= top),
        QueueMove::Down => Some(from + 1).filter(|&place| place < party.queue.len()),
        QueueMove::Next => Some(top).filter(|&place| place != from),
    }
    .ok_or(UserMessage::RequestCannotMove)?;
    let request = party.queue.remove(from);
    party.queue.insert(target, request);
    Ok(())
}

/// Removes Request `id`, the head included: then the next Request becomes
/// the head, or there is none and the song browser shows. The Request whose
/// Song plays is refused with [`UserMessage::RequestPlaying`]: Skip or End
/// does that.
pub fn remove(party: &mut PartySnapshot, id: RequestId) -> Result<Request, UserMessage> {
    let at = position(party, id)?;
    if party
        .playing
        .as_ref()
        .is_some_and(|playing| playing.request_id == id)
    {
        return Err(UserMessage::RequestPlaying);
    }
    let request = party.queue.remove(at);
    if party.head == Some(id) {
        party.head = party.queue.first().map(|r| r.request_id);
    }
    Ok(request)
}

/// Replaces the requested Players of Request `id`, under the rules of
/// [`check_players`].
pub fn set_players(
    party: &mut PartySnapshot,
    id: RequestId,
    players: Vec<PartyMemberId>,
) -> Result<(), UserMessage> {
    let at = position(party, id)?;
    check_players(party, &players)?;
    party.queue[at].requested_players = players;
    Ok(())
}

pub fn find(party: &PartySnapshot, id: RequestId) -> Result<&Request, UserMessage> {
    position(party, id).map(|at| &party.queue[at])
}

fn position(party: &PartySnapshot, id: RequestId) -> Result<usize, UserMessage> {
    party
        .queue
        .iter()
        .position(|r| r.request_id == id)
        .ok_or(UserMessage::RequestNotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openstar_protocol::library::SongId;
    use openstar_protocol::profile::{PaletteKey, ProfileId};
    use openstar_protocol::{Identity, PartyMember, RequestKind, StageId};
    use proptest::prelude::*;

    fn party_with_members(members: u32) -> PartySnapshot {
        let mut party = super::super::party::start_party(&StageId("main".into()), None, 1).unwrap();
        for n in 1..=members {
            party.members.push(PartyMember {
                member_id: PartyMemberId(n),
                identity: Identity::Profile {
                    profile_id: ProfileId(n),
                },
                colour: PaletteKey::ALL[n as usize - 1],
                favourite_taken: false,
                on_phone: true,
                singing: false,
            });
        }
        party
    }

    fn request(id: u32) -> Request {
        Request {
            request_id: RequestId(id),
            kind: RequestKind::Song,
            song_id: SongId(id),
            requested_players: Vec::new(),
            adder: None,
        }
    }

    /// A Party whose Queue holds Requests 1..=n, with 1 as the head.
    fn queue_of(n: u32) -> PartySnapshot {
        let mut party = party_with_members(2);
        for id in 1..=n {
            add(&mut party, request(id));
        }
        party
    }

    fn order(party: &PartySnapshot) -> Vec<u32> {
        party.queue.iter().map(|r| r.request_id.0).collect()
    }

    fn member(n: u32) -> PartyMemberId {
        PartyMemberId(n)
    }

    #[test]
    fn adding_goes_to_the_end_and_the_first_request_becomes_the_head() {
        let mut party = party_with_members(0);
        assert_eq!(party.head, None);
        add(&mut party, request(7));
        assert_eq!(party.head, Some(RequestId(7)));
        add(&mut party, request(8));
        assert_eq!(order(&party), vec![7, 8]);
        assert_eq!(party.head, Some(RequestId(7)));
    }

    #[test]
    fn while_results_show_an_added_request_waits_for_next_instead_of_becoming_the_head() {
        let mut party = party_with_members(0);
        party.results = Some(openstar_protocol::SongResults {
            request_id: RequestId(6),
            song_id: SongId(6),
            ended: openstar_protocol::SongEnd::Played,
        });
        add(&mut party, request(7));
        assert_eq!(order(&party), vec![7]);
        assert_eq!(party.head, None);
    }

    #[test]
    fn the_request_whose_song_plays_cannot_be_removed() {
        let mut party = queue_of(2);
        party.playing = Some(openstar_protocol::PlayingSong {
            request_id: RequestId(1),
            song_id: SongId(1),
            paused: false,
        });
        assert_eq!(
            remove(&mut party, RequestId(1)),
            Err(UserMessage::RequestPlaying)
        );
        assert_eq!(order(&party), vec![1, 2]);
        assert!(remove(&mut party, RequestId(2)).is_ok());
    }

    #[test]
    fn move_up_and_move_down_move_one_place() {
        let mut party = queue_of(4);
        move_request(&mut party, RequestId(4), QueueMove::Up).unwrap();
        assert_eq!(order(&party), vec![1, 2, 4, 3]);
        move_request(&mut party, RequestId(2), QueueMove::Down).unwrap();
        assert_eq!(order(&party), vec![1, 4, 2, 3]);
    }

    #[test]
    fn play_next_moves_a_request_directly_after_the_head() {
        let mut party = queue_of(4);
        move_request(&mut party, RequestId(4), QueueMove::Next).unwrap();
        assert_eq!(order(&party), vec![1, 4, 2, 3]);
        assert_eq!(party.head, Some(RequestId(1)));
    }

    #[test]
    fn the_head_never_moves_and_nothing_moves_above_it() {
        let mut party = queue_of(3);
        for to in [QueueMove::Up, QueueMove::Down, QueueMove::Next] {
            assert_eq!(
                move_request(&mut party, RequestId(1), to),
                Err(UserMessage::RequestCannotMove)
            );
        }
        assert_eq!(
            move_request(&mut party, RequestId(2), QueueMove::Up),
            Err(UserMessage::RequestCannotMove)
        );
        assert_eq!(
            move_request(&mut party, RequestId(2), QueueMove::Next),
            Err(UserMessage::RequestCannotMove)
        );
        assert_eq!(
            move_request(&mut party, RequestId(3), QueueMove::Down),
            Err(UserMessage::RequestCannotMove)
        );
        assert_eq!(order(&party), vec![1, 2, 3]);
    }

    #[test]
    fn without_a_head_the_first_request_can_be_moved() {
        // While the results screen shows (#87) no Request is the head.
        let mut party = queue_of(3);
        party.head = None;
        move_request(&mut party, RequestId(2), QueueMove::Up).unwrap();
        assert_eq!(order(&party), vec![2, 1, 3]);
        move_request(&mut party, RequestId(3), QueueMove::Next).unwrap();
        assert_eq!(order(&party), vec![3, 2, 1]);
    }

    #[test]
    fn an_unknown_request_is_refused() {
        let mut party = queue_of(2);
        assert_eq!(
            move_request(&mut party, RequestId(9), QueueMove::Up),
            Err(UserMessage::RequestNotFound)
        );
        assert_eq!(
            remove(&mut party, RequestId(9)),
            Err(UserMessage::RequestNotFound)
        );
        assert_eq!(
            set_players(&mut party, RequestId(9), vec![]),
            Err(UserMessage::RequestNotFound)
        );
    }

    #[test]
    fn removing_the_head_makes_the_next_request_the_head() {
        let mut party = queue_of(3);
        remove(&mut party, RequestId(1)).unwrap();
        assert_eq!(party.head, Some(RequestId(2)));
        remove(&mut party, RequestId(3)).unwrap();
        assert_eq!(party.head, Some(RequestId(2)));
        remove(&mut party, RequestId(2)).unwrap();
        assert_eq!(party.head, None);
        assert!(party.queue.is_empty());
    }

    #[test]
    fn a_phone_request_defaults_to_its_member_who_is_also_the_adder() {
        let party = party_with_members(3);
        let phone = Actor::Member {
            member_id: member(2),
        };
        assert_eq!(
            new_request_players(&party, phone, None),
            Ok((vec![member(2)], Some(member(2))))
        );
        assert_eq!(
            new_request_players(&party, phone, Some(vec![])),
            Ok((vec![], Some(member(2))))
        );
        assert_eq!(
            new_request_players(&party, phone, Some(vec![member(3), member(1)])),
            Ok((vec![member(3), member(1)], Some(member(2))))
        );
    }

    #[test]
    fn a_stage_request_has_no_adder_and_no_requested_players() {
        let party = party_with_members(1);
        assert_eq!(
            new_request_players(&party, Actor::Stage, None),
            Ok((vec![], None))
        );
        assert_eq!(
            new_request_players(&party, Actor::Stage, Some(vec![member(1)])),
            Err(UserMessage::InvalidMessage)
        );
    }

    #[test]
    fn requested_players_are_members_named_once_and_at_most_seats() {
        let party = party_with_members(SEATS as u32 + 1);
        let all: Vec<PartyMemberId> = (1..=SEATS as u32 + 1).map(member).collect();
        assert_eq!(check_players(&party, &all[..SEATS]), Ok(()));
        assert_eq!(
            check_players(&party, &all),
            Err(UserMessage::TooManyPlayers { max: SEATS as u32 })
        );
        assert_eq!(
            check_players(&party, &[member(1), member(99)]),
            Err(UserMessage::PlayerNotInParty)
        );
        assert_eq!(
            check_players(&party, &[member(1), member(1)]),
            Err(UserMessage::PlayerTwice)
        );
    }

    #[test]
    fn changing_requested_players_follows_the_same_rules() {
        let mut party = queue_of(2);
        set_players(&mut party, RequestId(2), vec![member(2), member(1)]).unwrap();
        assert_eq!(party.queue[1].requested_players, vec![member(2), member(1)]);
        assert_eq!(
            set_players(&mut party, RequestId(2), vec![member(5)]),
            Err(UserMessage::PlayerNotInParty)
        );
        assert_eq!(party.queue[1].requested_players, vec![member(2), member(1)]);
    }

    proptest! {
        /// Whatever moves and removals happen, the head stays first, the
        /// Queue keeps every Request exactly once, and refused moves change
        /// nothing.
        #[test]
        fn the_head_stays_first(
            n in 1_u32..8,
            steps in proptest::collection::vec((1_u32..10, 0_u8..4), 0..30),
        ) {
            let mut party = queue_of(n);
            for (id, step) in steps {
                let before = party.clone();
                let result = match step {
                    0 => move_request(&mut party, RequestId(id), QueueMove::Up),
                    1 => move_request(&mut party, RequestId(id), QueueMove::Down),
                    2 => move_request(&mut party, RequestId(id), QueueMove::Next),
                    _ => remove(&mut party, RequestId(id)).map(|_| ()),
                };
                if result.is_err() {
                    prop_assert_eq!(&party, &before);
                }
                if step < 3 && result.is_ok() {
                    prop_assert_eq!(party.queue[0].request_id, before.queue[0].request_id);
                    let mut ids = order(&party);
                    ids.sort_unstable();
                    let mut was = order(&before);
                    was.sort_unstable();
                    prop_assert_eq!(ids, was);
                }
                prop_assert_eq!(party.head, party.queue.first().map(|r| r.request_id));
            }
        }
    }
}
