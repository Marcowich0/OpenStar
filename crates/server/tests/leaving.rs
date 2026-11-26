//! Leaving the Party and removing Party members over real HTTP and
//! WebSocket: the colour is free at once, every Phone on the member is out
//! and needs the Join code, Requests drop the member, Guests are gone and
//! Profiles may enter again, and a member in the Line-up stays.

use std::path::Path;

use openstar_protocol::library::{SongList, SongSummary};
use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey, Profile};
use openstar_protocol::{
    Actor, ChangeEvent, ClientMessage, Identity, JoinAs, JoinCode, NewGuest, PartyEvent,
    PartyMemberId, PartySnapshot, PhoneId, ServerMessage, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

fn star() -> Avatar {
    Avatar::BuiltIn {
        key: AvatarKey::Star,
    }
}

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

async fn refused(socket: &mut WsClient, message: ClientMessage) -> UserMessage {
    socket.send(&message).await;
    match recv(socket).await {
        ServerMessage::Rejected { reason } => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// Asserts that nothing arrived on `socket` before the answer to a ping.
async fn heard_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 77 });
}

async fn create_profile(app: &TestApp, name: &str, favourite: PaletteKey) -> Profile {
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(&NewProfile {
            name: name.to_owned(),
            avatar: star(),
            favourite_colour: favourite,
        })
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    response.json().await.unwrap()
}

async fn first_stage(app: &TestApp) -> (WsClient, JoinCode) {
    let mut stage = app.connect_stage().await;
    live_party(&mut stage).await;
    let (party, _) = party_changed(&mut stage).await;
    (stage, party.join_code)
}

fn phone_id(n: u32) -> PhoneId {
    PhoneId(format!("4b1d8f0e-0000-4000-8000-{n:012}"))
}

fn join(n: u32, code: &JoinCode, join_as: JoinAs) -> ClientMessage {
    ClientMessage::Join {
        phone_id: phone_id(n),
        join_code: code.clone(),
        join_as,
    }
}

fn as_profile(profile: &Profile) -> JoinAs {
    JoinAs::Profile {
        profile_id: profile.id,
    }
}

fn guest(name: &str, colour: PaletteKey) -> JoinAs {
    JoinAs::Guest(NewGuest {
        name: name.to_owned(),
        colour,
        avatar: star(),
    })
}

/// Opens Phone `n`'s connection and joins it; returns the socket and its
/// member id, past what the join sent it. Every socket in `others` hears
/// the join.
async fn joined(
    app: &TestApp,
    others: &mut [&mut WsClient],
    n: u32,
    message: ClientMessage,
) -> (WsClient, PartyMemberId) {
    let mut socket = app.connect_ws().await;
    live_party(&mut socket).await;
    socket.send(&message).await;
    let member_id = match recv(&mut socket).await {
        ServerMessage::PhoneStatus {
            member_id: Some(member_id),
        } => member_id,
        other => panic!("expected Phone {n}'s status, got {other:?}"),
    };
    party_changed(&mut socket).await;
    for other in others.iter_mut() {
        party_changed(other).await;
    }
    (socket, member_id)
}

fn colours(party: &PartySnapshot) -> Vec<PaletteKey> {
    party.members.iter().map(|member| member.colour).collect()
}

#[tokio::test]
async fn a_removed_phone_is_out_and_needs_the_code_to_come_back() {
    let app = TestApp::start().await;
    let (mut stage, code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let lukas = create_profile(&app, "Lukas", PaletteKey::Tangerine).await;
    let (mut bo_phone, bo_id) =
        joined(&app, &mut [&mut stage], 1, join(1, &code, as_profile(&bo))).await;
    let (mut lukas_phone, lukas_id) = joined(
        &app,
        &mut [&mut stage, &mut bo_phone],
        2,
        join(2, &code, as_profile(&lukas)),
    )
    .await;
    // Lukas is on a second Phone too.
    let (mut lukas_second, _) = joined(
        &app,
        &mut [&mut stage, &mut bo_phone, &mut lukas_phone],
        3,
        join(3, &code, as_profile(&lukas)),
    )
    .await;

    // Bo removes Lukas from the people list: no Admin PIN.
    bo_phone
        .send(&ClientMessage::RemoveMember {
            member_id: lukas_id,
        })
        .await;
    for socket in [&mut lukas_phone, &mut lukas_second] {
        assert_eq!(recv(socket).await, ServerMessage::LeftParty);
    }
    let expected = ChangeEvent {
        actor: Actor::Member { member_id: bo_id },
        event: PartyEvent::MemberLeft {
            member_id: lukas_id,
            name: "Lukas".into(),
            avatar: star(),
            colour: PaletteKey::Tangerine,
        },
    };
    for socket in [
        &mut stage,
        &mut bo_phone,
        &mut lukas_phone,
        &mut lukas_second,
    ] {
        let (party, change) = party_changed(socket).await;
        assert_eq!(change, expected);
        assert_eq!(colours(&party), vec![PaletteKey::Sky]);
        assert_eq!(party.phones.len(), 1);
        assert_eq!(party.phones[0].phone_id, phone_id(1));
    }

    // Commands from the removed Phone are no longer the Party's.
    assert_eq!(
        refused(&mut lukas_phone, ClientMessage::LeaveParty).await,
        UserMessage::NotInParty
    );

    // Reconnecting with its Phone id no longer rejoins it silently: it is
    // told again that it left (it may have been asleep when it was removed).
    drop(lukas_phone);
    let mut back = app.connect_ws().await;
    live_party(&mut back).await;
    back.send(&ClientMessage::Hello {
        phone_id: phone_id(2),
    })
    .await;
    assert_eq!(recv(&mut back).await, ServerMessage::LeftParty);
    assert_eq!(
        refused(
            &mut back,
            join(2, &JoinCode("no code".into()), as_profile(&lukas))
        )
        .await,
        UserMessage::JoinCodeWrong
    );

    // With the code, the Profile enters again and gets its colour by the
    // usual rule.
    back.send(&join(2, &code, as_profile(&lukas))).await;
    let ServerMessage::PhoneStatus {
        member_id: Some(again),
    } = recv(&mut back).await
    else {
        panic!("expected the Phone to be in the Party again");
    };
    let (party, change) = party_changed(&mut stage).await;
    assert_eq!(
        change.event,
        PartyEvent::MemberJoined {
            member_id: again,
            name: "Lukas".into(),
            colour: PaletteKey::Tangerine,
        }
    );
    assert_eq!(
        colours(&party),
        vec![PaletteKey::Sky, PaletteKey::Tangerine]
    );
}

#[tokio::test]
async fn a_guest_who_leaves_is_gone_and_its_colour_and_name_are_free_again() {
    let app = TestApp::start().await;
    let (mut stage, code) = first_stage(&app).await;
    let (mut kim, kim_id) = joined(
        &app,
        &mut [&mut stage],
        1,
        join(1, &code, guest("Kim", PaletteKey::Teal)),
    )
    .await;

    kim.send(&ClientMessage::LeaveParty).await;
    assert_eq!(recv(&mut kim).await, ServerMessage::LeftParty);
    let (party, change) = party_changed(&mut stage).await;
    assert_eq!(
        change,
        ChangeEvent {
            actor: Actor::Member { member_id: kim_id },
            event: PartyEvent::MemberLeft {
                member_id: kim_id,
                name: "Kim".into(),
                avatar: star(),
                colour: PaletteKey::Teal,
            },
        }
    );
    assert!(party.members.is_empty() && party.phones.is_empty());

    // Another Guest may take both the name and the colour.
    let (_lou, _) = joined(
        &app,
        &mut [&mut stage],
        2,
        join(2, &code, guest("kim", PaletteKey::Teal)),
    )
    .await;

    // The Guest stays gone after a restart.
    drop(stage);
    let mut app = app;
    app.restart().await;
    let mut socket = app.connect_ws().await;
    let party = live_party(&mut socket).await.unwrap();
    assert_eq!(party.members.len(), 1);
    assert_eq!(
        party.members[0].identity,
        Identity::Guest {
            name: "kim".into(),
            avatar: star(),
            difficulty: openstar_protocol::profile::Difficulty::Medium,
        }
    );
}

#[tokio::test]
async fn only_the_party_removes_members_and_a_phone_leaves_rather_than_removing_itself() {
    let app = TestApp::start().await;
    let (mut stage, code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let (mut bo_phone, bo_id) =
        joined(&app, &mut [&mut stage], 1, join(1, &code, as_profile(&bo))).await;
    let mut stranger = app.connect_ws().await;
    live_party(&mut stranger).await;

    let remove = |member_id| ClientMessage::RemoveMember { member_id };
    assert_eq!(
        refused(&mut stranger, remove(bo_id)).await,
        UserMessage::NotInParty
    );
    assert_eq!(
        refused(&mut stranger, ClientMessage::LeaveParty).await,
        UserMessage::NotInParty
    );
    // The Stage has no member of its own to take out.
    assert_eq!(
        refused(&mut stage, ClientMessage::LeaveParty).await,
        UserMessage::NotInParty
    );
    assert_eq!(
        refused(&mut bo_phone, remove(bo_id)).await,
        UserMessage::UseLeaveParty
    );
    assert_eq!(
        refused(&mut bo_phone, remove(PartyMemberId(99))).await,
        UserMessage::MemberNotFound
    );
    heard_nothing(&mut stage).await;

    // The Stage removes anyone who is not singing.
    stage.send(&remove(bo_id)).await;
    assert_eq!(recv(&mut bo_phone).await, ServerMessage::LeftParty);
    let (party, change) = party_changed(&mut stage).await;
    assert_eq!(change.actor, Actor::Stage);
    assert!(party.members.is_empty());
}

/// Writes a playable Song into `folder`.
fn write_song(folder: &Path, title: &str) {
    std::fs::create_dir_all(folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:Toto\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n"),
    )
    .unwrap();
}

#[tokio::test]
async fn a_singing_member_stays_and_a_leaving_member_drops_out_of_every_request() {
    let mut app = TestApp::start().await;
    write_song(&app.songs_dir().join("Toto - Africa"), "Africa");
    write_song(&app.songs_dir().join("Toto - Rosanna"), "Rosanna");
    app.restart().await;
    let songs: Vec<SongSummary> = app.get_json::<SongList>("/api/songs").await.songs;
    let song = |title: &str| songs.iter().find(|s| s.title == title).unwrap().id;

    let (mut stage, code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let ann = create_profile(&app, "Ann", PaletteKey::Lime).await;
    let (mut bo_phone, bo_id) =
        joined(&app, &mut [&mut stage], 1, join(1, &code, as_profile(&bo))).await;
    let (mut ann_phone, ann_id) = joined(
        &app,
        &mut [&mut stage, &mut bo_phone],
        2,
        join(2, &code, as_profile(&ann)),
    )
    .await;

    // Bo sings Africa now (the head's Line-up waits); Bo and Ann asked for
    // Rosanna, which Ann added.
    bo_phone
        .send(&ClientMessage::AddRequest {
            song_id: song("Africa"),
            requested_players: None,
        })
        .await;
    party_changed(&mut stage).await;
    party_changed(&mut ann_phone).await;
    party_changed(&mut bo_phone).await;
    ann_phone
        .send(&ClientMessage::AddRequest {
            song_id: song("Rosanna"),
            requested_players: Some(vec![bo_id, ann_id]),
        })
        .await;
    party_changed(&mut bo_phone).await;
    party_changed(&mut ann_phone).await;
    let (party, _) = party_changed(&mut stage).await;
    assert_eq!(party.line_up.unwrap().seats[0].member_id, bo_id);

    // Bo sits in the Line-up: nobody can remove Bo, and Bo cannot leave.
    assert_eq!(
        refused(
            &mut ann_phone,
            ClientMessage::RemoveMember { member_id: bo_id }
        )
        .await,
        UserMessage::MemberSinging
    );
    assert_eq!(
        refused(&mut bo_phone, ClientMessage::LeaveParty).await,
        UserMessage::MemberSinging
    );
    heard_nothing(&mut stage).await;

    // Ann leaves: Rosanna keeps Bo alone and still names Ann as adder (the
    // Remotes show no adder for her, never "from the Stage").
    ann_phone.send(&ClientMessage::LeaveParty).await;
    assert_eq!(recv(&mut ann_phone).await, ServerMessage::LeftParty);
    let (party, _) = party_changed(&mut stage).await;
    assert_eq!(party.queue[1].requested_players, vec![bo_id]);
    assert_eq!(party.queue[1].adder, Some(ann_id));

    // So it stays after a restart.
    drop((stage, bo_phone, ann_phone));
    app.restart().await;
    let mut socket = app.connect_ws().await;
    let party = live_party(&mut socket).await.unwrap();
    assert_eq!(party.queue[1].requested_players, vec![bo_id]);
    assert_eq!(party.queue[1].adder, Some(ann_id));
    assert_eq!(colours(&party), vec![PaletteKey::Sky]);
}
