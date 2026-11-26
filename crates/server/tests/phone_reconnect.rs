//! A Phone that drops off the network and comes back (ticket #129): it
//! presents its Phone id on the new WebSocket and is the same Player in the
//! same seat at once, its Pitch readings reach the Stage again under the
//! same Mic, and its blocked-mic report still stands.

use futures_util::StreamExt;
use openstar_protocol::library::{SongId, SongList, SongSummary};
use openstar_protocol::mics::MicKey;
use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey, Profile};
use openstar_protocol::{
    ClientMessage, JoinAs, JoinCode, LineUpWarning, MicId, PartyMemberId, PartySnapshot, PhoneId,
    PitchReading, ServerMessage,
};
use openstar_test_harness::{TestApp, WsClient};

const PHONE: &str = "4b1d8f0e-0000-4000-8000-000000000129";

/// A fresh app whose Library holds the one-Voice Song "Solo".
async fn app_with_solo() -> (TestApp, SongId) {
    let mut app = TestApp::start().await;
    let folder = app.songs_dir().join("Solo");
    std::fs::create_dir_all(&folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        "#ARTIST:Placeholder\n#TITLE:Solo\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n",
    )
    .unwrap();
    app.restart().await;
    let songs: Vec<SongSummary> = app.get_json::<SongList>("/api/songs").await.songs;
    let solo = songs
        .iter()
        .find(|song| song.title == "Solo")
        .expect("Solo is in the Library")
        .id;
    (app, solo)
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

async fn live_party(socket: &mut WsClient) -> Option<PartySnapshot> {
    match recv(socket).await {
        ServerMessage::LiveState { party, .. } => party,
        other => panic!("expected the live state first, got {other:?}"),
    }
}

/// Asserts `socket` heard nothing since: a Ping's Pong comes next.
async fn heard_nothing(socket: &mut WsClient) {
    socket.send(&ClientMessage::Ping { nonce: 77 }).await;
    assert_eq!(recv(socket).await, ServerMessage::Pong { nonce: 77 });
}

/// Drops `socket` as a network drop would, and waits until the server has
/// handled the close.
async fn drop_connection(socket: WsClient) {
    let mut socket = socket.into_socket();
    socket.close(None).await.unwrap();
    while socket.next().await.is_some_and(|frame| frame.is_ok()) {}
}

async fn create_profile(app: &TestApp, name: &str) -> Profile {
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(&NewProfile {
            name: name.to_owned(),
            avatar: Avatar::BuiltIn {
                key: AvatarKey::Star,
            },
            favourite_colour: PaletteKey::Sky,
        })
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    response.json().await.unwrap()
}

/// The Stage, past its greeting and the Party it started.
async fn first_stage(app: &TestApp) -> (WsClient, JoinCode) {
    let mut stage = app.connect_stage().await;
    live_party(&mut stage).await;
    let party = party_changed(&mut stage).await;
    (stage, party.join_code)
}

/// Joins the Phone as a new Profile "Mia"; `stage` hears the join.
async fn join_mia(
    app: &TestApp,
    stage: &mut WsClient,
    code: &JoinCode,
) -> (WsClient, PartyMemberId) {
    let profile = create_profile(app, "Mia").await;
    let mut phone = app.connect_ws().await;
    live_party(&mut phone).await;
    phone
        .send(&ClientMessage::Join {
            phone_id: PhoneId(PHONE.into()),
            join_code: code.clone(),
            join_as: JoinAs::Profile {
                profile_id: profile.id,
            },
        })
        .await;
    let ServerMessage::PhoneStatus {
        member_id: Some(member_id),
    } = recv(&mut phone).await
    else {
        panic!("expected the Phone's status");
    };
    party_changed(&mut phone).await;
    party_changed(stage).await;
    (phone, member_id)
}

fn reading(capture_ms: f64) -> PitchReading {
    PitchReading {
        capture_ms,
        pitch: Some(69.25),
        clarity: 0.93,
        loudness: -24.5,
    }
}

async fn reading_at_stage(stage: &mut WsClient) -> (MicId, PitchReading) {
    match recv(stage).await {
        ServerMessage::PitchReading { mic, reading } => (mic, reading),
        other => panic!("expected a Pitch reading, got {other:?}"),
    }
}

#[tokio::test]
async fn a_reconnecting_phone_is_the_same_player_in_the_same_seat_and_its_readings_reach_the_stage_again()
 {
    let (app, solo) = app_with_solo().await;
    let (mut stage, code) = first_stage(&app).await;
    let (mut phone, mia) = join_mia(&app, &mut stage, &code).await;
    let mic = MicId::Phone {
        phone_id: PhoneId(PHONE.into()),
    };
    let seat_mic = Some(MicKey::Phone {
        phone_id: PHONE.into(),
    });

    // Mia asks for Solo: the Line-up waits with her in the seat, on her Phone.
    phone
        .send(&ClientMessage::AddRequest {
            song_id: solo,
            requested_players: None,
        })
        .await;
    let party = party_changed(&mut stage).await;
    let seats = party.line_up.expect("a Line-up waits").seats;
    assert_eq!(seats.len(), 1);
    assert_eq!((seats[0].member_id, &seats[0].mic), (mia, &seat_mic));
    party_changed(&mut phone).await;

    // Her mic would not open, and she said so.
    phone
        .send(&ClientMessage::ReportMicBlocked { blocked: true })
        .await;
    party_changed(&mut stage).await;
    party_changed(&mut phone).await;

    phone
        .send(&ClientMessage::PitchReading {
            reading: reading(1.0),
            input: None,
        })
        .await;
    assert_eq!(
        reading_at_stage(&mut stage).await,
        (mic.clone(), reading(1.0))
    );

    // The network drops.
    drop_connection(phone).await;
    assert_eq!(
        recv(&mut stage).await,
        ServerMessage::MicClosed { mic: mic.clone() }
    );

    // The Phone comes back by itself and presents its Phone id: the same
    // Player, with nobody acting and nothing else changing.
    let mut again = app.connect_ws().await;
    let party = live_party(&mut again).await.expect("the Party is on");
    let seats = party.line_up.expect("the Line-up still waits").seats;
    assert_eq!((seats[0].member_id, &seats[0].mic), (mia, &seat_mic));
    again
        .send(&ClientMessage::Hello {
            phone_id: PhoneId(PHONE.into()),
        })
        .await;
    assert_eq!(
        recv(&mut again).await,
        ServerMessage::PhoneStatus {
            member_id: Some(mia)
        }
    );
    heard_nothing(&mut stage).await;

    // Its readings reach the Stage again, under the same Mic.
    again
        .send(&ClientMessage::PitchReading {
            reading: reading(2.0),
            input: None,
        })
        .await;
    assert_eq!(
        reading_at_stage(&mut stage).await,
        (mic.clone(), reading(2.0))
    );

    // The block still stands, and saying so again changes nothing.
    again
        .send(&ClientMessage::ReportMicBlocked { blocked: true })
        .await;
    heard_nothing(&mut stage).await;
    again
        .send(&ClientMessage::ReportMicBlocked { blocked: false })
        .await;
    let party = party_changed(&mut stage).await;
    let line_up = party.line_up.unwrap();
    assert_eq!(line_up.warnings, Vec::<LineUpWarning>::new());
    assert_eq!(line_up.seats[0].member_id, mia);
}
