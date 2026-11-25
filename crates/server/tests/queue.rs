//! The Queue over real HTTP and WebSocket: adding Requests from a Phone and
//! from the Stage, moving and removing them, changing requested Players,
//! refusals, restart survival and New party.

use std::path::Path;

use openstar_protocol::library::{SongId, SongSummary};
use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey, Profile};
use openstar_protocol::{
    Actor, ChangeEvent, ClientMessage, JoinAs, JoinCode, PartyEvent, PartyMemberId, PartySnapshot,
    PhoneId, QueueMove, Request, RequestChange, RequestId, RequestKind, SEATS, ServerMessage,
    UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

/// Writes a playable Song (`song.txt` + empty `song.mp3`) into `folder`.
fn write_song(folder: &Path, artist: &str, title: &str) {
    std::fs::create_dir_all(folder).unwrap();
    std::fs::write(folder.join("song.mp3"), b"").unwrap();
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:{artist}\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n"),
    )
    .unwrap();
}

/// A fresh app whose Library holds the Songs "Africa" and "Rosanna".
async fn app_with_songs() -> (TestApp, SongId, SongId) {
    let mut app = TestApp::start().await;
    write_song(&app.songs_dir().join("Toto - Africa"), "Toto", "Africa");
    write_song(&app.songs_dir().join("Toto - Rosanna"), "Toto", "Rosanna");
    // The start-up scan of the restart indexes them.
    app.restart().await;
    let songs: Vec<SongSummary> = app.get_json("/api/songs").await;
    let id = |title: &str| {
        songs
            .iter()
            .find(|song| song.title == title)
            .unwrap_or_else(|| panic!("{title} is in the Library: {songs:?}"))
            .id
    };
    let (africa, rosanna) = (id("Africa"), id("Rosanna"));
    (app, africa, rosanna)
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

async fn rejected(socket: &mut WsClient) -> UserMessage {
    match recv(socket).await {
        ServerMessage::Rejected { reason } => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
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

/// Opens the Stage on a fresh server; returns it and the Join code.
async fn first_stage(app: &TestApp) -> (WsClient, JoinCode) {
    let mut stage = app.connect_stage().await;
    live_party(&mut stage).await;
    let (party, _) = party_changed(&mut stage).await;
    (stage, party.join_code)
}

/// Joins a new Phone `n` as a new Profile `name`; returns its socket and
/// member id, past every message the join sent it. `stage` hears the join.
async fn joined_phone(
    app: &TestApp,
    stage: &mut WsClient,
    code: &JoinCode,
    n: u32,
    name: &str,
    favourite: PaletteKey,
) -> (WsClient, PartyMemberId) {
    let profile = create_profile(app, name, favourite).await;
    let mut socket = app.connect_ws().await;
    live_party(&mut socket).await;
    socket
        .send(&ClientMessage::Join {
            phone_id: PhoneId(format!("4b1d8f0e-0000-4000-8000-{n:012}")),
            join_code: code.clone(),
            join_as: JoinAs::Profile {
                profile_id: profile.id,
            },
        })
        .await;
    let member_id = match recv(&mut socket).await {
        ServerMessage::PhoneStatus {
            member_id: Some(member_id),
        } => member_id,
        other => panic!("expected the Phone's status, got {other:?}"),
    };
    party_changed(&mut socket).await;
    party_changed(stage).await;
    (socket, member_id)
}

fn add(song_id: SongId, requested_players: Option<Vec<PartyMemberId>>) -> ClientMessage {
    ClientMessage::AddRequest {
        song_id,
        requested_players,
    }
}

fn change(request_id: RequestId, song_id: SongId, title: &str) -> RequestChange {
    RequestChange {
        request_id,
        song_id,
        title: title.to_owned(),
    }
}

fn order(party: &PartySnapshot) -> Vec<RequestId> {
    party.queue.iter().map(|r| r.request_id).collect()
}

#[tokio::test]
async fn a_phone_adds_a_request_for_its_member_and_everyone_hears_it() {
    let (app, africa, _) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let (mut bo, bo_id) = joined_phone(&app, &mut stage, &code, 1, "Bo", PaletteKey::Sky).await;

    bo.send(&add(africa, None)).await;
    let (party, change_event) = party_changed(&mut bo).await;
    assert_eq!(
        party_changed(&mut stage).await,
        (party.clone(), change_event.clone())
    );

    let request = &party.queue[0];
    assert_eq!(
        request,
        &Request {
            request_id: request.request_id,
            kind: RequestKind::Song,
            song_id: africa,
            requested_players: vec![bo_id],
            adder: Some(bo_id),
        }
    );
    assert_eq!(party.head, Some(request.request_id));
    assert_eq!(
        change_event,
        ChangeEvent {
            actor: Actor::Member { member_id: bo_id },
            event: PartyEvent::RequestAdded(change(request.request_id, africa, "Africa")),
        }
    );
    // `kind` is on the wire as `song`.
    let wire = serde_json::to_value(request).unwrap();
    assert_eq!(wire["kind"], "song");
}

#[tokio::test]
async fn a_stage_request_has_no_adder_and_no_requested_players() {
    let (app, africa, _) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let (_bo, bo_id) = joined_phone(&app, &mut stage, &code, 1, "Bo", PaletteKey::Sky).await;

    stage.send(&add(africa, Some(vec![bo_id]))).await;
    assert_eq!(rejected(&mut stage).await, UserMessage::InvalidMessage);

    stage.send(&add(africa, None)).await;
    let (party, change_event) = party_changed(&mut stage).await;
    assert_eq!(party.queue[0].requested_players, vec![]);
    assert_eq!(party.queue[0].adder, None);
    assert_eq!(change_event.actor, Actor::Stage);
}

#[tokio::test]
async fn only_library_songs_are_queued_and_only_by_the_party() {
    let (app, africa, _) = app_with_songs().await;
    let (mut stage, _) = first_stage(&app).await;

    stage.send(&add(SongId(9_999), None)).await;
    assert_eq!(rejected(&mut stage).await, UserMessage::SongNotInLibrary);

    let mut stranger = app.connect_ws().await;
    live_party(&mut stranger).await;
    stranger.send(&add(africa, None)).await;
    assert_eq!(rejected(&mut stranger).await, UserMessage::NotInParty);
}

#[tokio::test]
async fn requested_players_from_a_phone_are_party_members_at_most_seats() {
    let (app, africa, _) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let (mut bo, bo_id) = joined_phone(&app, &mut stage, &code, 1, "Bo", PaletteKey::Sky).await;
    let (mut al, al_id) = joined_phone(&app, &mut stage, &code, 2, "Al", PaletteKey::Mint).await;
    party_changed(&mut bo).await; // Al's join

    bo.send(&add(africa, Some(vec![al_id, bo_id]))).await;
    let (party, _) = party_changed(&mut bo).await;
    assert_eq!(party.queue[0].requested_players, vec![al_id, bo_id]);
    assert_eq!(party.queue[0].adder, Some(bo_id));

    al.send(&add(africa, Some(vec![]))).await;
    party_changed(&mut al).await; // Bo's Request
    let (party, _) = party_changed(&mut al).await;
    assert_eq!(party.queue[1].requested_players, vec![]);
    assert_eq!(party.queue[1].adder, Some(al_id));

    al.send(&add(africa, Some(vec![PartyMemberId(77)]))).await;
    assert_eq!(rejected(&mut al).await, UserMessage::PlayerNotInParty);
    al.send(&add(africa, Some(vec![al_id; SEATS + 1]))).await;
    assert_eq!(
        rejected(&mut al).await,
        UserMessage::TooManyPlayers { max: SEATS as u32 }
    );
}

/// Adds `songs` from the Stage; returns the Queue's ids, past every
/// message on `stage` and `others`.
async fn queue_up(
    stage: &mut WsClient,
    others: &mut [&mut WsClient],
    songs: &[SongId],
) -> Vec<RequestId> {
    let mut ids = Vec::new();
    for &song in songs {
        stage.send(&add(song, None)).await;
        let (party, _) = party_changed(stage).await;
        for other in others.iter_mut() {
            party_changed(other).await;
        }
        ids = order(&party);
    }
    ids
}

#[tokio::test]
async fn requests_move_one_place_or_next_but_never_the_head() {
    let (app, africa, rosanna) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let (mut bo, bo_id) = joined_phone(&app, &mut stage, &code, 1, "Bo", PaletteKey::Sky).await;
    let ids = queue_up(
        &mut stage,
        &mut [&mut bo],
        &[africa, rosanna, africa, rosanna],
    )
    .await;
    let [a, b, c, d] = ids[..] else {
        panic!("{ids:?}")
    };

    bo.send(&ClientMessage::MoveRequest {
        request_id: d,
        to: QueueMove::Next,
    })
    .await;
    let (party, change_event) = party_changed(&mut bo).await;
    assert_eq!(order(&party), vec![a, d, b, c]);
    assert_eq!(party.head, Some(a));
    assert_eq!(
        change_event,
        ChangeEvent {
            actor: Actor::Member { member_id: bo_id },
            event: PartyEvent::RequestPlayNext(change(d, rosanna, "Rosanna")),
        }
    );

    bo.send(&ClientMessage::MoveRequest {
        request_id: c,
        to: QueueMove::Up,
    })
    .await;
    let (party, change_event) = party_changed(&mut bo).await;
    assert_eq!(order(&party), vec![a, d, c, b]);
    assert_eq!(
        change_event.event,
        PartyEvent::RequestMovedUp(change(c, africa, "Africa"))
    );

    stage
        .send(&ClientMessage::MoveRequest {
            request_id: d,
            to: QueueMove::Down,
        })
        .await;
    party_changed(&mut stage).await;
    party_changed(&mut stage).await;
    let (party, change_event) = party_changed(&mut stage).await;
    assert_eq!(order(&party), vec![a, c, d, b]);
    assert_eq!(change_event.actor, Actor::Stage);
    assert_eq!(
        change_event.event,
        PartyEvent::RequestMovedDown(change(d, rosanna, "Rosanna"))
    );

    for (request_id, to) in [
        (a, QueueMove::Down),
        (a, QueueMove::Next),
        (c, QueueMove::Up),
        (b, QueueMove::Down),
    ] {
        stage
            .send(&ClientMessage::MoveRequest { request_id, to })
            .await;
        assert_eq!(rejected(&mut stage).await, UserMessage::RequestCannotMove);
    }
    stage
        .send(&ClientMessage::MoveRequest {
            request_id: RequestId(999),
            to: QueueMove::Up,
        })
        .await;
    assert_eq!(rejected(&mut stage).await, UserMessage::RequestNotFound);
}

#[tokio::test]
async fn anyone_changes_requested_players_and_removes_any_request_the_head_included() {
    let (app, africa, rosanna) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let (mut bo, bo_id) = joined_phone(&app, &mut stage, &code, 1, "Bo", PaletteKey::Sky).await;
    let ids = queue_up(&mut stage, &mut [&mut bo], &[africa, rosanna]).await;
    let [a, b] = ids[..] else { panic!("{ids:?}") };

    stage
        .send(&ClientMessage::SetRequestedPlayers {
            request_id: b,
            requested_players: vec![bo_id],
        })
        .await;
    let (party, change_event) = party_changed(&mut stage).await;
    assert_eq!(party.queue[1].requested_players, vec![bo_id]);
    assert_eq!(
        change_event.event,
        PartyEvent::RequestedPlayersChanged(change(b, rosanna, "Rosanna"))
    );
    stage
        .send(&ClientMessage::SetRequestedPlayers {
            request_id: b,
            requested_players: vec![bo_id, bo_id],
        })
        .await;
    assert_eq!(rejected(&mut stage).await, UserMessage::PlayerTwice);

    bo.send(&ClientMessage::RemoveRequest { request_id: a })
        .await;
    party_changed(&mut bo).await; // the Stage's change of players
    let (party, change_event) = party_changed(&mut bo).await;
    assert_eq!(order(&party), vec![b]);
    assert_eq!(party.head, Some(b));
    assert_eq!(
        change_event,
        ChangeEvent {
            actor: Actor::Member { member_id: bo_id },
            event: PartyEvent::RequestRemoved(change(a, africa, "Africa")),
        }
    );

    bo.send(&ClientMessage::RemoveRequest { request_id: b })
        .await;
    let (party, _) = party_changed(&mut bo).await;
    assert_eq!(party.queue, vec![]);
    assert_eq!(party.head, None);
}

#[tokio::test]
async fn the_queue_survives_a_restart_and_new_party_clears_it() {
    let (mut app, africa, rosanna) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let (mut bo, bo_id) = joined_phone(&app, &mut stage, &code, 1, "Bo", PaletteKey::Sky).await;
    bo.send(&add(rosanna, None)).await;
    party_changed(&mut bo).await;
    party_changed(&mut stage).await;
    let ids = queue_up(&mut stage, &mut [&mut bo], &[africa, rosanna, africa]).await;
    let [_, _, c, d] = ids[..] else {
        panic!("{ids:?}")
    };
    // A moved order and a removed Request are what must come back.
    stage
        .send(&ClientMessage::MoveRequest {
            request_id: c,
            to: QueueMove::Next,
        })
        .await;
    party_changed(&mut stage).await;
    stage
        .send(&ClientMessage::RemoveRequest { request_id: d })
        .await;
    let (before, _) = party_changed(&mut stage).await;
    assert_eq!(before.queue.len(), 3);
    assert_eq!(before.queue[0].adder, Some(bo_id));
    assert_eq!(before.queue[0].requested_players, vec![bo_id]);
    drop((stage, bo));

    app.restart().await;
    let mut stage = app.connect_stage().await;
    let after = live_party(&mut stage).await.unwrap();
    assert_eq!(after.queue, before.queue);
    assert_eq!(after.head, before.head);

    // Ids are never reused, also after a restart.
    stage.send(&add(africa, None)).await;
    let (party, _) = party_changed(&mut stage).await;
    assert!(party.queue[3].request_id > d);

    stage.send(&ClientMessage::NewParty).await;
    let (party, _) = party_changed(&mut stage).await;
    assert_eq!(party.queue, vec![]);
    assert_eq!(party.head, None);

    drop(stage);
    app.restart().await;
    let mut socket = app.connect_ws().await;
    let party = live_party(&mut socket).await.unwrap();
    assert_eq!(party.queue, vec![]);
}
