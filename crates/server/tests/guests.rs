//! Guests, new Profiles from a Phone, name clashes and switching identity,
//! over real HTTP and WebSocket.

use openstar_protocol::profile::{
    Avatar, AvatarKey, Difficulty, NewProfile, PaletteKey, Profile, ProfileEdit,
};
use openstar_protocol::{
    Actor, ChangeEvent, ClientMessage, Identity, JoinAs, JoinCode, MemberEdit, NewGuest,
    PartyEvent, PartyMember, PartyMemberId, PartySnapshot, PhoneId, ServerMessage, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};
use reqwest::StatusCode;

/// The next message on `socket`, past change notices for HTTP data.
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

/// The current Party as a newly opened browser sees it.
async fn current_party(app: &TestApp) -> PartySnapshot {
    live_party(&mut app.connect_ws().await).await.unwrap()
}

/// Opens the Stage on a fresh server and returns it with its Join code.
async fn first_stage(app: &TestApp) -> (WsClient, JoinCode) {
    let mut stage = app.connect_stage().await;
    live_party(&mut stage).await;
    let (party, _) = party_changed(&mut stage).await;
    (stage, party.join_code)
}

fn phone_id(n: u32) -> PhoneId {
    PhoneId(format!("4b1d8f0e-0000-4000-8000-{n:012}"))
}

fn avatar(key: AvatarKey) -> Avatar {
    Avatar::BuiltIn { key }
}

fn new_profile(name: &str, favourite: PaletteKey) -> NewProfile {
    NewProfile {
        name: name.to_owned(),
        avatar: avatar(AvatarKey::Star),
        favourite_colour: favourite,
    }
}

async fn post_profile(app: &TestApp, body: &NewProfile) -> (StatusCode, serde_json::Value) {
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(body)
        .send()
        .await
        .unwrap();
    (response.status(), response.json().await.unwrap())
}

async fn create_profile(app: &TestApp, name: &str, favourite: PaletteKey) -> Profile {
    let (status, body) = post_profile(app, &new_profile(name, favourite)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    serde_json::from_value(body).unwrap()
}

async fn patch_profile(
    app: &TestApp,
    profile: &Profile,
    edit: &ProfileEdit,
) -> (StatusCode, serde_json::Value) {
    let response = app
        .http()
        .patch(app.url(&format!("/api/profiles/{}", profile.id.0)))
        .json(edit)
        .send()
        .await
        .unwrap();
    (response.status(), response.json().await.unwrap())
}

async fn profiles(app: &TestApp) -> Vec<Profile> {
    app.get_json("/api/profiles").await
}

/// A Phone's connection, past its live state.
async fn phone(app: &TestApp) -> WsClient {
    let mut socket = app.connect_ws().await;
    live_party(&mut socket).await;
    socket
}

fn guest(name: &str, colour: PaletteKey) -> JoinAs {
    JoinAs::Guest(NewGuest {
        name: name.to_owned(),
        colour,
        avatar: avatar(AvatarKey::Ghost),
    })
}

fn join(n: u32, code: &JoinCode, join_as: JoinAs) -> ClientMessage {
    ClientMessage::Join {
        phone_id: phone_id(n),
        join_code: code.clone(),
        join_as,
    }
}

/// Sends `message`, which makes a Phone join or switch, and returns the
/// Party after it, past the Phone's own status.
async fn entered(socket: &mut WsClient, message: ClientMessage) -> (PartySnapshot, ChangeEvent) {
    socket.send(&message).await;
    let status = recv(socket).await;
    assert!(
        matches!(status, ServerMessage::PhoneStatus { member_id: Some(_) }),
        "{status:?}"
    );
    party_changed(socket).await
}

async fn refused(socket: &mut WsClient, message: ClientMessage) -> UserMessage {
    socket.send(&message).await;
    match recv(socket).await {
        ServerMessage::Rejected { reason } => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn last(party: &PartySnapshot) -> PartyMember {
    party.members.last().cloned().unwrap()
}

/// Joins Phones 100.. as twelve Guests, one per colour.
async fn fill_party(app: &TestApp, code: &JoinCode) {
    let mut socket = phone(app).await;
    for (n, colour) in PaletteKey::ALL.into_iter().enumerate() {
        entered(
            &mut socket,
            join(100 + n as u32, code, guest(&format!("G{n}"), colour)),
        )
        .await;
    }
}

#[tokio::test]
async fn a_new_guest_joins_with_its_name_free_colour_and_avatar_on_medium() {
    let app = TestApp::start().await;
    let (mut stage, code) = first_stage(&app).await;
    let mut socket = phone(&app).await;

    let (party, change) = entered(
        &mut socket,
        join(1, &code, guest(" Kim ", PaletteKey::Teal)),
    )
    .await;
    let kim = last(&party);
    assert_eq!(
        kim.identity,
        Identity::Guest {
            name: "Kim".into(),
            avatar: avatar(AvatarKey::Ghost),
            difficulty: Difficulty::Medium,
        }
    );
    assert_eq!(kim.colour, PaletteKey::Teal);
    assert!(kim.on_phone);
    assert_eq!(
        change,
        ChangeEvent {
            actor: Actor::Member {
                member_id: kim.member_id
            },
            event: PartyEvent::MemberJoined {
                member_id: kim.member_id,
                name: "Kim".into(),
                colour: PaletteKey::Teal,
            },
        }
    );
    assert_eq!(party_changed(&mut stage).await.0, party);

    // The colour must be free; the avatar need not be unique.
    assert_eq!(
        refused(&mut socket, join(2, &code, guest("Lou", PaletteKey::Teal))).await,
        UserMessage::ColourTaken
    );
    let (party, _) = entered(
        &mut socket,
        join(2, &code, guest("Lou", PaletteKey::Cherry)),
    )
    .await;
    assert_eq!(last(&party).colour, PaletteKey::Cherry);
    assert_eq!(party.members.len(), 2);
    // No Profile was made for a Guest.
    assert!(profiles(&app).await.is_empty());
}

#[tokio::test]
async fn guest_names_follow_the_profile_name_rules_within_the_party() {
    let app = TestApp::start().await;
    let (_stage, code) = first_stage(&app).await;
    let mut socket = phone(&app).await;
    entered(&mut socket, join(1, &code, guest("Kim", PaletteKey::Teal))).await;

    assert_eq!(
        refused(
            &mut socket,
            join(2, &code, guest("  kIM ", PaletteKey::Lime))
        )
        .await,
        UserMessage::NameTakenTonight {
            member_id: PartyMemberId(1)
        }
    );
    assert_eq!(
        refused(
            &mut socket,
            join(2, &code, guest("Seventeen chars!!", PaletteKey::Lime))
        )
        .await,
        UserMessage::ProfileNameTooLong { max_length: 16 }
    );
    assert_eq!(
        refused(&mut socket, join(2, &code, guest("   ", PaletteKey::Lime))).await,
        UserMessage::ProfileNameEmpty
    );
    assert_eq!(current_party(&app).await.members.len(), 1);
}

#[tokio::test]
async fn a_guest_name_that_is_a_profiles_name_is_refused_with_that_profile() {
    let app = TestApp::start().await;
    let (_stage, code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let mut socket = phone(&app).await;

    assert_eq!(
        refused(&mut socket, join(1, &code, guest(" BO", PaletteKey::Lime))).await,
        UserMessage::ProfileNameTaken { profile_id: bo.id }
    );
    assert!(current_party(&app).await.members.is_empty());
}

#[tokio::test]
async fn a_new_profile_with_a_current_guests_name_is_refused_everywhere() {
    let app = TestApp::start().await;
    let (_stage, code) = first_stage(&app).await;
    let mut socket = phone(&app).await;
    entered(&mut socket, join(1, &code, guest("Kim", PaletteKey::Teal))).await;
    let taken = UserMessage::NameTakenTonight {
        member_id: PartyMemberId(1),
    };

    // Over HTTP.
    let (status, body) = post_profile(&app, &new_profile("kim", PaletteKey::Sky)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(serde_json::from_value::<UserMessage>(body).unwrap(), taken);
    // From a Phone, as one step with joining.
    let join_as = JoinAs::NewProfile(new_profile(" KIM", PaletteKey::Sky));
    assert_eq!(refused(&mut socket, join(2, &code, join_as)).await, taken);
    // A rename to a Guest's name, too.
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let rename = ProfileEdit {
        name: Some("Kim".into()),
        ..ProfileEdit::default()
    };
    let (status, body) = patch_profile(&app, &bo, &rename).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(serde_json::from_value::<UserMessage>(body).unwrap(), taken);

    let names: Vec<String> = profiles(&app).await.into_iter().map(|p| p.name).collect();
    assert_eq!(names, ["Bo"]);
}

#[tokio::test]
async fn a_new_profile_from_a_phone_is_created_and_joined_in_one_step() {
    let app = TestApp::start().await;
    let (_stage, code) = first_stage(&app).await;
    let mut socket = phone(&app).await;
    entered(&mut socket, join(1, &code, guest("Kim", PaletteKey::Navy))).await;

    let join_as = JoinAs::NewProfile(new_profile(" Ana ", PaletteKey::Navy));
    let (party, change) = entered(&mut socket, join(2, &code, join_as)).await;
    let created = profiles(&app).await;
    assert_eq!(created.len(), 1);
    let ana = &created[0];
    assert_eq!(ana.name, "Ana");
    // Its favourite was held, so it entered with the first free colour.
    assert_eq!(ana.favourite_colour, PaletteKey::Navy);
    let member = last(&party);
    assert_eq!(member.identity, Identity::Profile { profile_id: ana.id });
    assert_eq!(member.colour, PaletteKey::Cherry);
    assert!(member.favourite_taken);
    assert_eq!(
        change.event,
        PartyEvent::MemberJoined {
            member_id: member.member_id,
            name: "Ana".into(),
            colour: PaletteKey::Cherry,
        }
    );

    // An existing Profile's name offers that Profile and creates nothing.
    let again = JoinAs::NewProfile(new_profile("ana", PaletteKey::Lime));
    assert_eq!(
        refused(&mut socket, join(3, &code, again)).await,
        UserMessage::ProfileNameTaken { profile_id: ana.id }
    );
    assert_eq!(profiles(&app).await.len(), 1);
}

#[tokio::test]
async fn with_twelve_colours_held_a_new_guest_or_profile_is_refused_and_nothing_is_created() {
    let app = TestApp::start().await;
    let (_stage, code) = first_stage(&app).await;
    fill_party(&app, &code).await;
    let before = current_party(&app).await;
    let mut socket = phone(&app).await;

    assert_eq!(
        refused(
            &mut socket,
            join(1, &code, guest("Late", PaletteKey::Cherry))
        )
        .await,
        UserMessage::PartyFull
    );
    let join_as = JoinAs::NewProfile(new_profile("Late", PaletteKey::Cherry));
    assert_eq!(
        refused(&mut socket, join(1, &code, join_as)).await,
        UserMessage::PartyFull
    );
    let (status, body) = post_profile(&app, &new_profile("Late", PaletteKey::Cherry)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        serde_json::from_value::<UserMessage>(body).unwrap(),
        UserMessage::PartyFull
    );

    assert!(profiles(&app).await.is_empty());
    assert_eq!(current_party(&app).await, before);
}

#[tokio::test]
async fn switching_identity_changes_only_this_phone_and_the_previous_member_stays() {
    let app = TestApp::start().await;
    let (mut stage, code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Lime).await;
    let mut socket = phone(&app).await;
    let mut other = phone(&app).await;

    // A Phone that has not joined cannot switch without the Join code.
    let switch = |join_as| ClientMessage::SwitchIdentity { join_as };
    assert_eq!(
        refused(&mut socket, switch(guest("Kim", PaletteKey::Teal))).await,
        UserMessage::NotInParty
    );

    entered(
        &mut socket,
        join(1, &code, JoinAs::Profile { profile_id: bo.id }),
    )
    .await;
    party_changed(&mut other).await;
    entered(
        &mut other,
        join(2, &code, JoinAs::Profile { profile_id: bo.id }),
    )
    .await;
    party_changed(&mut socket).await;
    party_changed(&mut stage).await;
    party_changed(&mut stage).await;

    let (party, _) = entered(&mut socket, switch(guest("Kim", PaletteKey::Teal))).await;
    let bo_member = &party.members[0];
    assert_eq!(bo_member.identity, Identity::Profile { profile_id: bo.id });
    assert_eq!(bo_member.colour, PaletteKey::Lime);
    // Bo is still on Phone 2; Phone 1 is Kim now.
    assert!(bo_member.on_phone);
    let kim = last(&party);
    let phones: Vec<(PhoneId, PartyMemberId)> = party
        .phones
        .iter()
        .map(|p| (p.phone_id.clone(), p.member_id))
        .collect();
    assert_eq!(
        phones,
        [
            (phone_id(1), kim.member_id),
            (phone_id(2), bo_member.member_id)
        ]
    );

    // Switching away from the Guest keeps the Guest, colour and all.
    let (party, change) = entered(&mut socket, switch(JoinAs::Profile { profile_id: bo.id })).await;
    assert_eq!(
        change.event,
        PartyEvent::PhoneJoined {
            member_id: bo_member.member_id,
            name: "Bo".into()
        }
    );
    assert_eq!(party.members.len(), 2);
    assert_eq!(party.members[1].colour, PaletteKey::Teal);
    assert!(!party.members[1].on_phone);
    // And the Guest is never turned into a Profile.
    assert_eq!(profiles(&app).await.len(), 1);
}

#[tokio::test]
async fn editing_a_colour_inside_the_party_offers_only_free_colours() {
    let app = TestApp::start().await;
    let (_stage, code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Lime).await;
    let mut socket = phone(&app).await;
    entered(&mut socket, join(1, &code, guest("Kim", PaletteKey::Teal))).await;
    let (party, _) = entered(
        &mut socket,
        join(2, &code, JoinAs::Profile { profile_id: bo.id }),
    )
    .await;
    let (kim, bo_member) = (party.members[0].member_id, party.members[1].member_id);
    let colour = |member_id, colour| ClientMessage::EditMember {
        member_id,
        edit: MemberEdit {
            colour: Some(colour),
            ..MemberEdit::default()
        },
    };

    assert_eq!(
        refused(&mut socket, colour(bo_member, PaletteKey::Teal)).await,
        UserMessage::ColourTaken
    );
    assert_eq!(
        refused(&mut socket, colour(PartyMemberId(9), PaletteKey::Mint)).await,
        UserMessage::MemberNotFound
    );

    // A Profile's choice becomes its favourite and its Party colour.
    socket.send(&colour(bo_member, PaletteKey::Berry)).await;
    let (party, change) = party_changed(&mut socket).await;
    assert_eq!(party.members[1].colour, PaletteKey::Berry);
    assert_eq!(
        change,
        ChangeEvent {
            actor: Actor::Member {
                member_id: bo_member
            },
            event: PartyEvent::MemberChanged {
                member_id: bo_member,
                name: "Bo".into()
            },
        }
    );
    assert_eq!(profiles(&app).await[0].favourite_colour, PaletteKey::Berry);

    // A Guest's choice is its Party colour.
    socket.send(&colour(kim, PaletteKey::Lime)).await;
    let (party, _) = party_changed(&mut socket).await;
    assert_eq!(party.members[0].colour, PaletteKey::Lime);

    // Outside the Party (the HTTP edit) a Profile may pick any colour: only
    // its favourite changes.
    let edit = ProfileEdit {
        favourite_colour: Some(PaletteKey::Lime),
        ..ProfileEdit::default()
    };
    let (status, _) = patch_profile(&app, &bo, &edit).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(profiles(&app).await[0].favourite_colour, PaletteKey::Lime);
    assert_eq!(
        current_party(&app).await.members[1].colour,
        PaletteKey::Berry
    );
}

#[tokio::test]
async fn editing_a_member_inside_the_party_keeps_names_apart() {
    let app = TestApp::start().await;
    let (_stage, code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Lime).await;
    let mut socket = phone(&app).await;
    entered(&mut socket, join(1, &code, guest("Kim", PaletteKey::Teal))).await;
    entered(&mut socket, join(2, &code, guest("Lou", PaletteKey::Sky))).await;
    let rename = |member_id: u32, name: &str| ClientMessage::EditMember {
        member_id: PartyMemberId(member_id),
        edit: MemberEdit {
            name: Some(name.to_owned()),
            avatar: Some(avatar(AvatarKey::Moon)),
            ..MemberEdit::default()
        },
    };

    assert_eq!(
        refused(&mut socket, rename(2, "kim")).await,
        UserMessage::NameTakenTonight {
            member_id: PartyMemberId(1)
        }
    );
    assert_eq!(
        refused(&mut socket, rename(2, "bo")).await,
        UserMessage::ProfileNameTaken { profile_id: bo.id }
    );
    socket.send(&rename(2, " Louise ")).await;
    let (party, change) = party_changed(&mut socket).await;
    assert_eq!(
        party.members[1].identity,
        Identity::Guest {
            name: "Louise".into(),
            avatar: avatar(AvatarKey::Moon),
            difficulty: Difficulty::Medium,
        }
    );
    assert_eq!(
        change.event,
        PartyEvent::MemberChanged {
            member_id: PartyMemberId(2),
            name: "Louise".into()
        }
    );
    // A joined Profile renamed in the Party changes the Profile itself.
    entered(
        &mut socket,
        join(3, &code, JoinAs::Profile { profile_id: bo.id }),
    )
    .await;
    assert_eq!(
        refused(&mut socket, rename(3, "KIM")).await,
        UserMessage::NameTakenTonight {
            member_id: PartyMemberId(1)
        }
    );
    socket.send(&rename(3, "Bodil")).await;
    party_changed(&mut socket).await;
    let bo_now = &profiles(&app).await[0];
    assert_eq!(bo_now.name, "Bodil");
    assert_eq!(bo_now.avatar, avatar(AvatarKey::Moon));
}

#[tokio::test]
async fn guests_survive_a_restart_and_end_at_new_party() {
    let mut app = TestApp::start().await;
    let (_stage, code) = first_stage(&app).await;
    let mut socket = phone(&app).await;
    entered(&mut socket, join(1, &code, guest("Kim", PaletteKey::Teal))).await;
    socket
        .send(&ClientMessage::EditMember {
            member_id: PartyMemberId(1),
            edit: MemberEdit {
                colour: Some(PaletteKey::Grape),
                ..MemberEdit::default()
            },
        })
        .await;
    let (before, _) = party_changed(&mut socket).await;

    app.restart().await;
    socket.closed().await;
    assert_eq!(current_party(&app).await, before);
    let mut back = phone(&app).await;
    back.send(&ClientMessage::Hello {
        phone_id: phone_id(1),
    })
    .await;
    assert_eq!(
        recv(&mut back).await,
        ServerMessage::PhoneStatus {
            member_id: Some(PartyMemberId(1))
        }
    );

    let mut stage = app.connect_stage().await;
    live_party(&mut stage).await;
    stage.send(&ClientMessage::NewParty).await;
    let (after, _) = party_changed(&mut stage).await;
    assert!(after.members.is_empty());
    // The name is free again in the new Party.
    let mut socket = phone(&app).await;
    let (party, _) = entered(
        &mut socket,
        join(1, &after.join_code, guest("Kim", PaletteKey::Teal)),
    )
    .await;
    assert_eq!(party.members.len(), 1);
}
