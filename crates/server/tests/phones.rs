//! Phones in the Party over real HTTP and WebSocket: checking the Join code,
//! joining as a Profile with a Party colour, a full Party, silent rejoin,
//! restart survival and New party.

use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey, Profile, ProfileId};
use openstar_protocol::{
    Actor, ChangeEvent, ClientMessage, Identity, JoinAs, JoinCode, JoinedPhone, PartyEvent,
    PartyMember, PartyMemberId, PartySnapshot, PhoneId, ServerMessage, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

/// The next message on `socket`, past change notices for HTTP data (each
/// Profile a test creates sends one).
async fn recv(socket: &mut WsClient) -> ServerMessage {
    loop {
        match socket.recv().await {
            ServerMessage::Changed { .. } => {}
            message => return message,
        }
    }
}

async fn party_changed(socket: &mut WsClient) -> (PartySnapshot, ChangeEvent) {
    match recv(socket).await {
        ServerMessage::PartyChanged { party, change } => (party, change),
        other => panic!("expected a Party change, got {other:?}"),
    }
}

async fn live_party(socket: &mut WsClient) -> Option<PartySnapshot> {
    match recv(socket).await {
        ServerMessage::LiveState { party, .. } => party,
        other => panic!("expected the live state first, got {other:?}"),
    }
}

/// Asserts that nothing arrived on `socket` before the answer to a ping.
async fn heard_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 77 });
}

/// Opens the Stage on a fresh server and returns it with its Party.
async fn first_stage(app: &TestApp) -> (WsClient, PartySnapshot) {
    let mut stage = app.connect_stage().await;
    live_party(&mut stage).await;
    let (party, _) = party_changed(&mut stage).await;
    (stage, party)
}

fn phone_id(n: u32) -> PhoneId {
    PhoneId(format!("4b1d8f0e-0000-4000-8000-{n:012}"))
}

async fn create_profile(app: &TestApp, name: &str, favourite: PaletteKey) -> Profile {
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(&NewProfile {
            name: name.to_owned(),
            avatar: Avatar::BuiltIn {
                key: AvatarKey::Star,
            },
            favourite_colour: favourite,
        })
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    response.json().await.unwrap()
}

/// A Phone's connection, past its live state.
async fn phone(app: &TestApp) -> WsClient {
    let mut socket = app.connect_ws().await;
    live_party(&mut socket).await;
    socket
}

fn join(n: u32, code: &JoinCode, profile: &Profile) -> ClientMessage {
    ClientMessage::Join {
        phone_id: phone_id(n),
        join_code: code.clone(),
        join_as: JoinAs::Profile {
            profile_id: profile.id,
        },
    }
}

/// Joins Phone `n` as `profile` and returns the Party after it, past the
/// Phone's own status.
async fn join_ok(
    socket: &mut WsClient,
    n: u32,
    code: &JoinCode,
    profile: &Profile,
) -> (PartySnapshot, ChangeEvent) {
    socket.send(&join(n, code, profile)).await;
    let status = recv(socket).await;
    let changed = party_changed(socket).await;
    let member_id = changed
        .0
        .phones
        .iter()
        .find(|phone| phone.phone_id == phone_id(n))
        .expect("the Phone is joined")
        .member_id;
    assert_eq!(
        status,
        ServerMessage::PhoneStatus {
            member_id: Some(member_id)
        }
    );
    changed
}

fn member(party: &PartySnapshot, profile: &Profile) -> PartyMember {
    party
        .members
        .iter()
        .find(|m| {
            m.identity
                == Identity::Profile {
                    profile_id: profile.id,
                }
        })
        .cloned()
        .expect("the Profile is a Party member")
}

fn rejected(reason: UserMessage) -> ServerMessage {
    ServerMessage::Rejected { reason }
}

#[tokio::test]
async fn the_join_code_can_be_checked_on_its_own_and_wrong_codes_are_never_held_against_anyone() {
    let app = TestApp::start().await;
    let (mut stage, party) = first_stage(&app).await;
    let mut socket = phone(&app).await;

    let wrong = JoinCode(
        if party.join_code.0 == "0000" {
            "0001"
        } else {
            "0000"
        }
        .to_owned(),
    );
    for _ in 0..50 {
        socket
            .send(&ClientMessage::CheckJoinCode {
                join_code: wrong.clone(),
            })
            .await;
        assert_eq!(
            recv(&mut socket).await,
            rejected(UserMessage::JoinCodeWrong)
        );
    }
    // Straight after fifty wrong codes, the right one is accepted at once.
    let started = std::time::Instant::now();
    socket
        .send(&ClientMessage::CheckJoinCode {
            join_code: party.join_code.clone(),
        })
        .await;
    assert_eq!(
        recv(&mut socket).await,
        ServerMessage::JoinCodeValid {
            join_code: party.join_code.clone()
        }
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    // Checking a code joins nobody.
    heard_nothing(&mut stage).await;
}

#[tokio::test]
async fn joining_needs_the_right_code_and_an_existing_profile() {
    let app = TestApp::start().await;
    let (mut stage, party) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let mut socket = phone(&app).await;

    socket
        .send(&join(1, &JoinCode("99999".to_owned()), &bo))
        .await;
    assert_eq!(
        recv(&mut socket).await,
        rejected(UserMessage::JoinCodeWrong)
    );

    socket
        .send(&ClientMessage::Join {
            phone_id: phone_id(1),
            join_code: party.join_code.clone(),
            join_as: JoinAs::Profile {
                profile_id: ProfileId(4242),
            },
        })
        .await;
    assert_eq!(
        recv(&mut socket).await,
        rejected(UserMessage::ProfileNotFound)
    );

    socket
        .send(&ClientMessage::Join {
            phone_id: PhoneId("not a phone id".to_owned()),
            join_code: party.join_code.clone(),
            join_as: JoinAs::Profile { profile_id: bo.id },
        })
        .await;
    assert_eq!(
        recv(&mut socket).await,
        rejected(UserMessage::InvalidMessage)
    );

    // None of it put the Phone in the Party.
    socket
        .send(&ClientMessage::Hello {
            phone_id: phone_id(1),
        })
        .await;
    assert_eq!(
        recv(&mut socket).await,
        ServerMessage::PhoneStatus { member_id: None }
    );
    heard_nothing(&mut stage).await;
}

#[tokio::test]
async fn a_profile_gets_its_favourite_colour_or_the_first_free_one_and_keeps_its_favourite() {
    let app = TestApp::start().await;
    let (mut stage, party) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Navy).await;
    let ana = create_profile(&app, "Ana", PaletteKey::Navy).await;
    let mut first = phone(&app).await;
    let mut second = phone(&app).await;

    let (after_bo, change) = join_ok(&mut first, 1, &party.join_code, &bo).await;
    assert_eq!(
        change,
        ChangeEvent {
            actor: Actor::Member {
                member_id: PartyMemberId(1)
            },
            event: PartyEvent::MemberJoined {
                member_id: PartyMemberId(1),
                name: "Bo".to_owned(),
                colour: PaletteKey::Navy,
            },
        }
    );
    assert_eq!(
        after_bo.members,
        vec![PartyMember {
            member_id: PartyMemberId(1),
            identity: Identity::Profile { profile_id: bo.id },
            colour: PaletteKey::Navy,
            favourite_taken: false,
            on_phone: true,
        }]
    );
    assert_eq!(
        after_bo.phones,
        vec![JoinedPhone {
            phone_id: phone_id(1),
            member_id: PartyMemberId(1)
        }]
    );
    // Everyone hears of it: the Stage and the other Phone.
    assert_eq!(party_changed(&mut stage).await.0, after_bo);
    assert_eq!(party_changed(&mut second).await.0, after_bo);

    let (after_ana, _) = join_ok(&mut second, 2, &party.join_code, &ana).await;
    let ana_member = member(&after_ana, &ana);
    assert_eq!(ana_member.colour, PaletteKey::Cherry);
    assert!(ana_member.favourite_taken);

    // The given colour is never saved back into the Profile.
    let stored: Profile = app.get_json(&format!("/api/profiles/{}", ana.id.0)).await;
    assert_eq!(stored.favourite_colour, PaletteKey::Navy);
}

#[tokio::test]
async fn a_second_phone_on_a_member_adds_no_member_even_when_the_party_is_full() {
    let app = TestApp::start().await;
    let (_stage, party) = first_stage(&app).await;
    let mut socket = phone(&app).await;
    // Made before the Party fills: a full Party refuses creating a Profile.
    let late = create_profile(&app, "Late", PaletteKey::Cherry).await;
    let mut profiles = Vec::new();
    for (n, colour) in PaletteKey::ALL.into_iter().enumerate() {
        let profile = create_profile(&app, &format!("P{n}"), colour).await;
        join_ok(&mut socket, n as u32, &party.join_code, &profile).await;
        profiles.push(profile);
    }

    // Twelve colours held: a Profile not yet in the Party is refused.
    socket.send(&join(99, &party.join_code, &late)).await;
    assert_eq!(recv(&mut socket).await, rejected(UserMessage::PartyFull));

    // A Profile already in the Party joins on another Phone all the same.
    let before = member(
        &live_party(&mut app.connect_ws().await).await.unwrap(),
        &profiles[3],
    );
    let (after, change) = join_ok(&mut socket, 99, &party.join_code, &profiles[3]).await;
    assert_eq!(after.members.len(), 12);
    assert_eq!(member(&after, &profiles[3]), before);
    assert_eq!(
        change.event,
        PartyEvent::PhoneJoined {
            member_id: before.member_id,
            name: "P3".to_owned()
        }
    );
    assert_eq!(after.phones.len(), 13);
}

#[tokio::test]
async fn a_phone_reconnecting_with_its_phone_id_rejoins_silently_with_the_same_identity() {
    let app = TestApp::start().await;
    let (mut stage, party) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Lime).await;
    let mut socket = phone(&app).await;
    let (joined, _) = join_ok(&mut socket, 1, &party.join_code, &bo).await;
    party_changed(&mut stage).await;
    drop(socket);

    // Disconnected, the Phone stays joined and its member keeps its colour.
    let mut other = phone(&app).await;
    let mut seen = live_party(&mut app.connect_ws().await).await.unwrap();
    assert_eq!(seen, joined);

    let mut back = app.connect_ws().await;
    seen = live_party(&mut back).await.unwrap();
    assert_eq!(seen, joined);
    back.send(&ClientMessage::Hello {
        phone_id: phone_id(1),
    })
    .await;
    assert_eq!(
        recv(&mut back).await,
        ServerMessage::PhoneStatus {
            member_id: Some(member(&joined, &bo).member_id)
        }
    );
    // Silent: nobody is told of a change.
    heard_nothing(&mut stage).await;
    heard_nothing(&mut other).await;

    // A Phone id the Party has never seen is not in it.
    other
        .send(&ClientMessage::Hello {
            phone_id: phone_id(2),
        })
        .await;
    assert_eq!(
        recv(&mut other).await,
        ServerMessage::PhoneStatus { member_id: None }
    );
}

#[tokio::test]
async fn members_and_joined_phones_survive_a_restart_and_phones_rejoin_by_themselves() {
    let mut app = TestApp::start().await;
    let (_stage, party) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Grape).await;
    let ana = create_profile(&app, "Ana", PaletteKey::Grape).await;
    let mut socket = phone(&app).await;
    join_ok(&mut socket, 1, &party.join_code, &bo).await;
    join_ok(&mut socket, 2, &party.join_code, &ana).await;
    let (before, _) = join_ok(&mut socket, 3, &party.join_code, &bo).await;

    app.restart().await;
    socket.closed().await;

    let mut back = app.connect_ws().await;
    assert_eq!(live_party(&mut back).await, Some(before.clone()));
    back.send(&ClientMessage::Hello {
        phone_id: phone_id(2),
    })
    .await;
    assert_eq!(
        recv(&mut back).await,
        ServerMessage::PhoneStatus {
            member_id: Some(member(&before, &ana).member_id)
        }
    );
}

#[tokio::test]
async fn new_party_clears_members_and_phones_tells_each_old_phone_and_issues_a_new_code() {
    let app = TestApp::start().await;
    let (mut stage, party) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Teal).await;
    let mut joined = phone(&app).await;
    let mut watcher = phone(&app).await;
    join_ok(&mut joined, 1, &party.join_code, &bo).await;
    party_changed(&mut stage).await;
    party_changed(&mut watcher).await;

    stage.send(&ClientMessage::NewParty).await;
    let (new, _) = party_changed(&mut stage).await;
    assert_ne!(new.join_code, party.join_code);
    assert!(new.members.is_empty());
    assert!(new.phones.is_empty());

    assert_eq!(recv(&mut joined).await, ServerMessage::LeftParty);
    assert_eq!(party_changed(&mut joined).await.0, new);
    // A browser that was never in the Party is not told it left.
    assert_eq!(party_changed(&mut watcher).await.0, new);

    // Reconnecting no longer rejoins; the old code no longer works.
    joined
        .send(&ClientMessage::Hello {
            phone_id: phone_id(1),
        })
        .await;
    assert_eq!(
        recv(&mut joined).await,
        ServerMessage::PhoneStatus { member_id: None }
    );
    joined.send(&join(1, &party.join_code, &bo)).await;
    assert_eq!(
        recv(&mut joined).await,
        rejected(UserMessage::JoinCodeWrong)
    );

    // With the new code, the Profile enters again with its favourite free.
    let (again, _) = join_ok(&mut joined, 1, &new.join_code, &bo).await;
    assert_eq!(member(&again, &bo).colour, PaletteKey::Teal);
    assert_eq!(member(&again, &bo).member_id, PartyMemberId(1));
}
