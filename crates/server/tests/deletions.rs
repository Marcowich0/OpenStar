//! The Party follows deletions, over real HTTP and WebSocket: a Song that
//! leaves the Library (gone at a Rescan) drops its queued Requests with a
//! change event, and a deleted Profile that is a Party member leaves the
//! Party the way Leave party does, unless it sings in the playing Song.
//!
//! A Profile is deleted at the Admin area's guarded `DELETE /api/profiles/{id}`
//! (#199); the Song delete belongs to #190.

use std::path::Path;

use openstar_protocol::library::{SongId, SongList, SongSummary};
use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey, Profile, ProfileId};
use openstar_protocol::{
    Actor, ChangeEvent, ClientMessage, JoinAs, JoinCode, PartyEvent, PartyMemberId, PartySnapshot,
    PhoneId, RequestChange, RequestId, ServerMessage, SongControl, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};
use reqwest::StatusCode;

fn star() -> Avatar {
    Avatar::BuiltIn {
        key: AvatarKey::Star,
    }
}

fn write_song(folder: &Path, title: &str) {
    std::fs::create_dir_all(folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:Placeholder\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n"),
    )
    .unwrap();
}

/// A fresh app whose Library holds "Solo" and "Encore".
async fn app_with_songs() -> (TestApp, SongId, SongId) {
    let mut app = TestApp::start().await;
    write_song(&app.songs_dir().join("Solo"), "Solo");
    write_song(&app.songs_dir().join("Encore"), "Encore");
    app.restart().await;
    let songs: Vec<SongSummary> = app.get_json::<SongList>("/api/songs").await.songs;
    let id = |title: &str| songs.iter().find(|song| song.title == title).unwrap().id;
    let (solo, encore) = (id("Solo"), id("Encore"));
    (app, solo, encore)
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

/// Every socket hears the same change; returns it.
async fn all_hear(sockets: &mut [&mut WsClient]) -> (PartySnapshot, ChangeEvent) {
    let mut heard = Vec::new();
    for socket in sockets.iter_mut() {
        heard.push(party_changed(socket).await);
    }
    for other in &heard[1..] {
        assert_eq!(other, &heard[0]);
    }
    heard.swap_remove(0)
}

/// Nothing more was sent to `socket`: a Ping is answered next.
async fn hears_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 77 });
}

async fn live_party(socket: &mut WsClient) -> Option<PartySnapshot> {
    match recv(socket).await {
        ServerMessage::LiveState { party, .. } => party,
        other => panic!("expected the live state first, got {other:?}"),
    }
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

/// Joins Phone `n` as Profile `profile`; returns its socket and member id,
/// past what the join sent it. Every socket in `others` hears the join.
async fn joined(
    app: &TestApp,
    others: &mut [&mut WsClient],
    code: &JoinCode,
    n: u32,
    profile: &Profile,
) -> (WsClient, PartyMemberId, PartySnapshot) {
    let mut socket = app.connect_ws().await;
    live_party(&mut socket).await;
    socket
        .send(&ClientMessage::Join {
            phone_id: phone_id(n),
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
        other => panic!("expected Phone {n}'s status, got {other:?}"),
    };
    let (party, _) = party_changed(&mut socket).await;
    for other in others.iter_mut() {
        party_changed(other).await;
    }
    (socket, member_id, party)
}

fn change(request_id: RequestId, song_id: SongId, title: &str) -> RequestChange {
    RequestChange {
        request_id,
        song_id,
        title: title.to_owned(),
    }
}

/// Adds a Request for `song` from `from`; everyone in `sockets` hears it.
async fn add(
    from: usize,
    sockets: &mut [&mut WsClient],
    song: SongId,
    requested_players: Option<Vec<PartyMemberId>>,
) -> (PartySnapshot, RequestId) {
    sockets[from]
        .send(&ClientMessage::AddRequest {
            song_id: song,
            requested_players,
        })
        .await;
    let (party, change) = all_hear(sockets).await;
    let PartyEvent::RequestAdded(added) = change.event else {
        panic!("expected a Request added, got {change:?}");
    };
    (party, added.request_id)
}

async fn rescan_without(app: &TestApp, folder: &str) {
    std::fs::remove_dir_all(app.songs_dir().join(folder)).unwrap();
    let response = app
        .http()
        .post(app.url("/api/library/rescan"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
}

/// Deletes Profile `id` at the guarded endpoint; the status and any refusal.
async fn delete_profile(
    app: &TestApp,
    cookie: &str,
    id: ProfileId,
) -> (StatusCode, Option<UserMessage>) {
    let response = app
        .http()
        .delete(app.url(&format!("/api/profiles/{}", id.0)))
        .header("cookie", cookie)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.bytes().await.unwrap();
    (status, serde_json::from_slice(&body).ok())
}

#[tokio::test]
async fn a_song_gone_at_a_rescan_drops_every_queued_request_for_it_with_a_change_event() {
    let (app, solo, encore) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let (mut bo_phone, _bo_id, _) = joined(&app, &mut [&mut stage], &code, 1, &bo).await;
    let mut sockets = [&mut stage, &mut bo_phone];
    let (_, first) = add(1, &mut sockets, solo, None).await;
    let (_, second) = add(1, &mut sockets, encore, None).await;
    let (_, third) = add(0, &mut sockets, solo, None).await;

    rescan_without(&app, "Solo").await;

    // The head's Request is dropped first: the next one becomes the head
    // with its Line-up. Every change names the Song and comes from nobody in
    // the Party, so it toasts on the Stage too.
    let (party, event) = all_hear(&mut sockets).await;
    assert_eq!(
        event,
        ChangeEvent {
            actor: Actor::Admin,
            event: PartyEvent::RequestDroppedSongGone(change(first, solo, "Solo")),
        }
    );
    assert_eq!(party.head, Some(second));
    assert_eq!(party.line_up.unwrap().request_id, second);
    let (party, event) = all_hear(&mut sockets).await;
    assert_eq!(
        event,
        ChangeEvent {
            actor: Actor::Admin,
            event: PartyEvent::RequestDroppedSongGone(change(third, solo, "Solo")),
        }
    );
    let queued: Vec<RequestId> = party.queue.iter().map(|r| r.request_id).collect();
    assert_eq!(queued, vec![second]);
    for socket in &mut sockets {
        hears_nothing(socket).await;
    }

    // The drop is stored: a restart keeps the Queue without the Song.
    drop((stage, bo_phone));
    let mut app = app;
    app.restart().await;
    let mut browser = app.connect_ws().await;
    let party = live_party(&mut browser).await.unwrap();
    let queued: Vec<RequestId> = party.queue.iter().map(|r| r.request_id).collect();
    assert_eq!(queued, vec![second]);
}

#[tokio::test]
async fn a_playing_song_gone_at_a_rescan_plays_on_and_its_later_requests_drop() {
    let (app, solo, encore) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let (mut bo_phone, _bo_id, _) = joined(&app, &mut [&mut stage], &code, 1, &bo).await;
    let mut sockets = [&mut stage, &mut bo_phone];
    let (_, playing) = add(1, &mut sockets, solo, None).await;
    let (_, later) = add(1, &mut sockets, solo, None).await;
    let (_, other) = add(1, &mut sockets, encore, None).await;
    sockets[1]
        .send(&ClientMessage::ControlSong {
            request_id: playing,
            control: SongControl::Start,
        })
        .await;
    all_hear(&mut sockets).await;
    assert!(matches!(
        recv(sockets[0]).await,
        ServerMessage::ControlSong { .. }
    ));

    rescan_without(&app, "Solo").await;

    let (party, event) = all_hear(&mut sockets).await;
    assert_eq!(
        event.event,
        PartyEvent::RequestDroppedSongGone(change(later, solo, "Solo"))
    );
    assert_eq!(party.playing.unwrap().request_id, playing);
    let queued: Vec<RequestId> = party.queue.iter().map(|r| r.request_id).collect();
    assert_eq!(queued, vec![playing, other]);
    for socket in &mut sockets {
        hears_nothing(socket).await;
    }
}

#[tokio::test]
async fn deleting_a_profile_in_the_party_frees_its_colour_and_drops_it_from_the_line_up_and_requests()
 {
    let (app, solo, encore) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let ann = create_profile(&app, "Ann", PaletteKey::Berry).await;
    let (mut bo_phone, bo_id, _) = joined(&app, &mut [&mut stage], &code, 1, &bo).await;
    let (mut ann_phone, ann_id, _) =
        joined(&app, &mut [&mut stage, &mut bo_phone], &code, 2, &ann).await;
    let mut sockets = [&mut stage, &mut ann_phone, &mut bo_phone];
    // Bo's Request is the head, with Bo seated in its waiting Line-up; Ann's
    // Request asks for both of them.
    let (_, bo_request) = add(2, &mut sockets, solo, None).await;
    let (party, ann_request) = add(1, &mut sockets, encore, Some(vec![ann_id, bo_id])).await;
    assert!(
        party
            .line_up
            .unwrap()
            .seats
            .iter()
            .any(|seat| seat.member_id == bo_id),
        "Bo sits in the waiting Line-up"
    );
    let cookie = app.unlock().await;

    assert_eq!(
        delete_profile(&app, &cookie, bo.id).await,
        (StatusCode::NO_CONTENT, None)
    );

    // Bo's Phone is out of the Party first, then everyone hears the change.
    assert_eq!(recv(sockets[2]).await, ServerMessage::LeftParty);
    let (party, event) = all_hear(&mut sockets).await;
    assert_eq!(
        event,
        ChangeEvent {
            actor: Actor::Admin,
            event: PartyEvent::ProfileDeleted {
                member_id: bo_id,
                name: "Bo".to_owned(),
                avatar: star(),
                colour: PaletteKey::Sky,
            },
        }
    );
    assert!(party.members.iter().all(|m| m.member_id != bo_id));
    assert!(party.phones.iter().all(|p| p.member_id != bo_id));
    let line_up = party.line_up.clone().unwrap();
    assert_eq!(line_up.request_id, bo_request);
    assert!(line_up.seats.iter().all(|seat| seat.member_id != bo_id));
    let ann_req = party
        .queue
        .iter()
        .find(|r| r.request_id == ann_request)
        .unwrap();
    assert_eq!(ann_req.requested_players, vec![ann_id]);
    let bo_req = party
        .queue
        .iter()
        .find(|r| r.request_id == bo_request)
        .unwrap();
    assert_eq!(bo_req.adder, Some(bo_id));
    assert!(
        app.http()
            .get(app.url(&format!("/api/profiles/{}", bo.id.0)))
            .send()
            .await
            .unwrap()
            .status()
            == StatusCode::NOT_FOUND
    );

    // Bo's Phone needs the Join code again: it is told it left.
    sockets[2]
        .send(&ClientMessage::Hello {
            phone_id: phone_id(1),
        })
        .await;
    assert_eq!(recv(sockets[2]).await, ServerMessage::LeftParty);

    // Sky is free: a new Profile whose favourite is Sky gets it.
    let cy = create_profile(&app, "Cy", PaletteKey::Sky).await;
    let [stage_socket, ann_socket, _] = &mut sockets;
    let mut others = [&mut **stage_socket, &mut **ann_socket];
    let (_, cy_id, party) = joined(&app, &mut others, &code, 3, &cy).await;
    let cy_member = party.members.iter().find(|m| m.member_id == cy_id).unwrap();
    assert_eq!(cy_member.colour, PaletteKey::Sky);
    assert!(!cy_member.favourite_taken);

    // A Profile that is not in the Party is deleted with no Party change;
    // an unknown one is not found.
    let dee = create_profile(&app, "Dee", PaletteKey::Mint).await;
    assert_eq!(
        delete_profile(&app, &cookie, dee.id).await,
        (StatusCode::NO_CONTENT, None)
    );
    assert_eq!(
        delete_profile(&app, &cookie, dee.id).await,
        (StatusCode::NOT_FOUND, Some(UserMessage::ProfileNotFound))
    );
    hears_nothing(sockets[0]).await;
}

#[tokio::test]
async fn deleting_a_profile_is_refused_while_it_sings_in_the_playing_song() {
    let (app, solo, _encore) = app_with_songs().await;
    let (mut stage, code) = first_stage(&app).await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let (mut bo_phone, bo_id, _) = joined(&app, &mut [&mut stage], &code, 1, &bo).await;
    let mut sockets = [&mut stage, &mut bo_phone];
    let (_, request) = add(1, &mut sockets, solo, None).await;
    sockets[1]
        .send(&ClientMessage::ControlSong {
            request_id: request,
            control: SongControl::Start,
        })
        .await;
    all_hear(&mut sockets).await;
    assert!(matches!(
        recv(sockets[0]).await,
        ServerMessage::ControlSong { .. }
    ));
    let cookie = app.unlock().await;

    assert_eq!(
        delete_profile(&app, &cookie, bo.id).await,
        (StatusCode::CONFLICT, Some(UserMessage::ProfileSinging))
    );
    for socket in &mut sockets {
        hears_nothing(socket).await;
    }
    let profiles: Vec<Profile> = app.get_json("/api/profiles").await;
    assert!(profiles.iter().any(|p| p.id == bo.id));

    // Once the Song is skipped Bo no longer sings, and the delete goes through.
    sockets[0]
        .send(&ClientMessage::ControlSong {
            request_id: request,
            control: SongControl::Skip,
        })
        .await;
    all_hear(&mut sockets).await;
    assert!(matches!(
        recv(sockets[0]).await,
        ServerMessage::ControlSong { .. }
    ));
    assert_eq!(
        delete_profile(&app, &cookie, bo.id).await,
        (StatusCode::NO_CONTENT, None)
    );
    assert_eq!(recv(sockets[1]).await, ServerMessage::LeftParty);
    let (party, event) = all_hear(&mut sockets).await;
    assert!(matches!(
        event.event,
        PartyEvent::ProfileDeleted { member_id, .. } if member_id == bo_id
    ));
    assert!(party.members.is_empty());
}

#[tokio::test]
async fn deleting_a_profile_is_refused_without_an_unlock_and_the_profile_stays() {
    let app = TestApp::start().await;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;

    let response = app
        .http()
        .delete(app.url(&format!("/api/profiles/{}", bo.id.0)))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let refusal: UserMessage = response.json().await.unwrap();
    assert_eq!(refusal, UserMessage::UnlockRequired);
    let profiles: Vec<Profile> = app.get_json("/api/profiles").await;
    assert!(profiles.iter().any(|p| p.id == bo.id));

    // With an Unlock the same call deletes it; a second call finds nothing.
    let cookie = app.unlock().await;
    assert_eq!(
        delete_profile(&app, &cookie, bo.id).await,
        (StatusCode::NO_CONTENT, None)
    );
    let profiles: Vec<Profile> = app.get_json("/api/profiles").await;
    assert!(profiles.iter().all(|p| p.id != bo.id));
    assert_eq!(
        delete_profile(&app, &cookie, bo.id).await,
        (StatusCode::NOT_FOUND, Some(UserMessage::ProfileNotFound))
    );
}
