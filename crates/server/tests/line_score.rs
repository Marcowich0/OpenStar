//! The Phone's Score in the mic takeover (#167): at each Line end the Stage
//! reports each seated Player's running total, and the server passes it to
//! that seat's Phone alone.

use std::path::Path;

use openstar_protocol::library::{SongList, SongSummary};
use openstar_protocol::mics::MicKey;
use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey, Profile};
use openstar_protocol::{
    ClientMessage, JoinAs, JoinCode, LineUpEdit, PartyMemberId, PartySnapshot, PhoneId, RequestId,
    SeatWho, ServerMessage, SongControl, UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

fn write_song(folder: &Path, title: &str) {
    std::fs::create_dir_all(folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        format!("#ARTIST:Placeholder\n#TITLE:{title}\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n"),
    )
    .unwrap();
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

async fn party_changed(socket: &mut WsClient) -> PartySnapshot {
    match recv(socket).await {
        ServerMessage::PartyChanged { party, .. } => party,
        other => panic!("expected a Party change, got {other:?}"),
    }
}

async fn all_hear(sockets: &mut [&mut WsClient]) -> PartySnapshot {
    let mut last = None;
    for socket in sockets.iter_mut() {
        last = Some(party_changed(socket).await);
    }
    last.unwrap()
}

/// Nothing more was sent to `socket`: a Ping is answered next.
async fn hears_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 77 });
}

async fn refused(socket: &mut WsClient, message: ClientMessage) -> UserMessage {
    socket.send(&message).await;
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

fn phone_id(n: u32) -> PhoneId {
    PhoneId(format!("4b1d8f0e-0000-4000-8000-{n:012}"))
}

/// Joins Phone `n` as `profile`, past what the join sent it; every socket in
/// `others` hears the join.
async fn joined(
    app: &TestApp,
    others: &mut [&mut WsClient],
    code: &JoinCode,
    n: u32,
    profile: &Profile,
) -> (WsClient, PartyMemberId) {
    let mut socket = app.connect_ws().await;
    assert!(matches!(
        recv(&mut socket).await,
        ServerMessage::LiveState { .. }
    ));
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
    party_changed(&mut socket).await;
    for other in others.iter_mut() {
        party_changed(other).await;
    }
    (socket, member_id)
}

fn line_score(request_id: RequestId, seat: u32, total: u32) -> ClientMessage {
    ClientMessage::ReportLineScore {
        request_id,
        seat,
        total,
    }
}

#[tokio::test]
async fn a_line_end_total_reaches_only_the_phone_of_its_seat() {
    let mut app = TestApp::start().await;
    write_song(&app.songs_dir().join("Solo"), "Solo");
    app.restart().await;
    let songs: Vec<SongSummary> = app.get_json::<SongList>("/api/songs").await.songs;
    let solo = songs[0].id;

    let mut stage = app.connect_stage().await;
    recv(&mut stage).await;
    let code = party_changed(&mut stage).await.join_code;
    let bo = create_profile(&app, "Bo", PaletteKey::Sky).await;
    let jonas = create_profile(&app, "Jonas", PaletteKey::Lime).await;
    let sara = create_profile(&app, "Sara", PaletteKey::Teal).await;
    let (mut bo_phone, _) = joined(&app, &mut [&mut stage], &code, 1, &bo).await;
    let (mut jonas_phone, jonas_id) =
        joined(&app, &mut [&mut stage, &mut bo_phone], &code, 2, &jonas).await;
    let (mut sara_phone, _) = joined(
        &app,
        &mut [&mut stage, &mut bo_phone, &mut jonas_phone],
        &code,
        3,
        &sara,
    )
    .await;
    let mut everyone = [&mut stage, &mut bo_phone, &mut jonas_phone, &mut sara_phone];

    // Bo's Request: Bo on Bo's Phone, Jonas on Jonas's Phone; Sara watches.
    everyone[1]
        .send(&ClientMessage::AddRequest {
            song_id: solo,
            requested_players: None,
        })
        .await;
    let request = all_hear(&mut everyone).await.line_up.unwrap().request_id;
    everyone[0]
        .send(&ClientMessage::EditLineUp {
            request_id: request,
            edit: LineUpEdit::AddSeat {
                who: SeatWho::Member {
                    member_id: jonas_id,
                },
            },
        })
        .await;
    all_hear(&mut everyone).await;
    everyone[0]
        .send(&ClientMessage::EditLineUp {
            request_id: request,
            edit: LineUpEdit::SetMic {
                seat: 1,
                mic: MicKey::Phone {
                    phone_id: phone_id(2).0,
                },
            },
        })
        .await;
    let party = all_hear(&mut everyone).await;
    assert!(party.line_up.as_ref().unwrap().can_start, "{party:?}");

    // Not before Start.
    assert_eq!(
        refused(everyone[0], line_score(request, 0, 100)).await,
        UserMessage::NoSongPlaying
    );

    everyone[0]
        .send(&ClientMessage::ControlSong {
            request_id: request,
            control: SongControl::Start,
        })
        .await;
    all_hear(&mut everyone).await;
    assert!(matches!(
        recv(everyone[0]).await,
        ServerMessage::ControlSong { .. }
    ));

    // A Line ends: seat 0 (Bo) is at 1200, seat 1 (Jonas) at 800.
    everyone[0].send(&line_score(request, 0, 1200)).await;
    everyone[0].send(&line_score(request, 1, 800)).await;
    assert_eq!(
        recv(everyone[1]).await,
        ServerMessage::LineScore {
            request_id: request,
            total: 1200
        }
    );
    assert_eq!(
        recv(everyone[2]).await,
        ServerMessage::LineScore {
            request_id: request,
            total: 800
        }
    );
    // Neither hears the other's, and nobody else hears either.
    for socket in everyone.iter_mut() {
        hears_nothing(socket).await;
    }

    // Only the active Stage reports, only for a seat of the playing Song.
    assert_eq!(
        refused(everyone[1], line_score(request, 0, 9000)).await,
        UserMessage::NotTheStage
    );
    assert_eq!(
        refused(everyone[0], line_score(RequestId(999), 0, 100)).await,
        UserMessage::NoSongPlaying
    );
    assert_eq!(
        refused(everyone[0], line_score(request, 2, 100)).await,
        UserMessage::InvalidMessage
    );
    assert_eq!(
        refused(everyone[0], line_score(request, 0, 10_001)).await,
        UserMessage::InvalidMessage
    );
}
