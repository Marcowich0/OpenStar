//! Local mics in the Line-up, over the real app: the Party snapshot lists
//! the switched-on Local mics by name with whether each is present (the
//! Stage reports its own devices, a Mic bridge is present while open), and
//! only present ones are prefilled or may be chosen.

use std::path::Path;

use futures_util::StreamExt;
use openstar_protocol::bridge::{BridgeId, BridgeInterface, bridge_local_mic_id};
use openstar_protocol::library::{SongId, SongList};
use openstar_protocol::mics::{LocalMicSource, MicKey, PartyLocalMic};
use openstar_protocol::profile::{Avatar, AvatarKey, NewProfile, PaletteKey, Profile};
use openstar_protocol::{
    ClientMessage, JoinAs, JoinCode, LineUpEdit, PartyEvent, PartySnapshot, PhoneId, ServerMessage,
    UserMessage,
};
use openstar_test_harness::{TestApp, WsClient};

fn write_song(folder: &Path) {
    std::fs::create_dir_all(folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        "#ARTIST:Placeholder\n#TITLE:Solo\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n",
    )
    .unwrap();
}

async fn app_with_song() -> (TestApp, SongId) {
    let mut app = TestApp::start().await;
    write_song(&app.songs_dir().join("Solo"));
    app.restart().await;
    let songs = app.get_json::<SongList>("/api/songs").await.songs;
    (app, songs[0].id)
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

/// The Party in the next Party change on `socket`, whatever it was.
async fn next_party(socket: &mut WsClient) -> PartySnapshot {
    loop {
        if let ServerMessage::PartyChanged { party, .. } = recv(socket).await {
            return party;
        }
    }
}

/// The Party once the Local mics changed (`localMicsChanged`).
async fn local_mics_changed(socket: &mut WsClient) -> PartySnapshot {
    loop {
        if let ServerMessage::PartyChanged { party, change } = recv(socket).await
            && change.event == PartyEvent::LocalMicsChanged
        {
            return party;
        }
    }
}

async fn first_stage(app: &TestApp) -> (WsClient, JoinCode) {
    let mut stage = app.connect_stage().await;
    assert!(matches!(
        recv(&mut stage).await,
        ServerMessage::LiveState { .. }
    ));
    let party = next_party(&mut stage).await;
    (stage, party.join_code)
}

fn browser_mic(device: &str, channel: u32) -> (String, LocalMicSource) {
    (
        format!("browser:stage-1:{device}:{channel}"),
        LocalMicSource::Browser {
            stage_browser: "stage-1".into(),
            device_id: device.into(),
            label: "USB Audio".into(),
            channel,
            stereo: true,
        },
    )
}

async fn switch_on(stage: &mut WsClient, (id, source): &(String, LocalMicSource)) {
    stage
        .send(&ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: id.clone(),
            source: source.clone(),
            switched_on: true,
        })
        .await;
}

async fn report(stage: &mut WsClient, ids: &[&String]) {
    stage
        .send(&ClientMessage::ReportPresentLocalMics {
            local_mic_ids: ids.iter().map(|id| (*id).clone()).collect(),
        })
        .await;
}

fn phone_id(n: u32) -> PhoneId {
    PhoneId(format!("4b1d8f0e-0000-4000-8000-{n:012}"))
}

/// Joins Phone `n` as a new Profile; returns its socket.
async fn joined_phone(app: &TestApp, code: &JoinCode, n: u32) -> WsClient {
    let response = app
        .http()
        .post(app.url("/api/profiles"))
        .json(&NewProfile {
            name: format!("Singer {n}"),
            avatar: Avatar::BuiltIn {
                key: AvatarKey::Star,
            },
            favourite_colour: PaletteKey::ALL[n as usize],
        })
        .send()
        .await
        .unwrap();
    let profile: Profile = response.json().await.unwrap();
    let mut socket = app.connect_ws().await;
    socket.recv().await;
    socket
        .send(&ClientMessage::Join {
            phone_id: phone_id(n),
            join_code: code.clone(),
            join_as: JoinAs::Profile {
                profile_id: profile.id,
            },
        })
        .await;
    next_party(&mut socket).await;
    socket
}

fn listed(party: &PartySnapshot) -> Vec<(String, String, bool)> {
    party
        .local_mics
        .iter()
        .map(
            |PartyLocalMic {
                 local_mic_id,
                 name,
                 present,
                 ..
             }| (local_mic_id.clone(), name.clone(), *present),
        )
        .collect()
}

#[tokio::test]
async fn a_present_switched_on_local_mic_is_listed_by_name_and_prefilled_before_a_phone() {
    let (app, solo) = app_with_song().await;
    let (mut stage, code) = first_stage(&app).await;
    let left = browser_mic("usb", 0);
    let right = browser_mic("usb", 1);

    // Switched on but not reported: listed, not present.
    switch_on(&mut stage, &left).await;
    let party = local_mics_changed(&mut stage).await;
    assert_eq!(listed(&party), vec![(left.0.clone(), String::new(), false)]);
    stage
        .send(&ClientMessage::SetLocalMicName {
            local_mic_id: left.0.clone(),
            source: left.1.clone(),
            name: "Red mic".into(),
        })
        .await;
    let party = local_mics_changed(&mut stage).await;
    assert_eq!(
        listed(&party),
        vec![(left.0.clone(), "Red mic".into(), false)]
    );

    // Both channels plugged in; only the switched-on one is listed.
    report(&mut stage, &[&left.0, &right.0]).await;
    let party = local_mics_changed(&mut stage).await;
    assert_eq!(
        listed(&party),
        vec![(left.0.clone(), "Red mic".into(), true)]
    );

    let mut phone = joined_phone(&app, &code, 1).await;
    phone
        .send(&ClientMessage::AddRequest {
            song_id: solo,
            requested_players: None,
        })
        .await;
    let party = next_party(&mut phone).await;
    let line_up = party.line_up.unwrap();
    assert_eq!(
        line_up.seats[0].mic,
        Some(MicKey::LocalMic {
            local_mic_id: left.0.clone()
        })
    );

    // Unplugged: it keeps its seat, is listed dimmed, and may not be chosen.
    report(&mut stage, &[]).await;
    let party = local_mics_changed(&mut stage).await;
    assert_eq!(
        listed(&party),
        vec![(left.0.clone(), "Red mic".into(), false)]
    );
    assert_eq!(
        party.line_up.as_ref().unwrap().seats[0].mic,
        Some(MicKey::LocalMic {
            local_mic_id: left.0.clone()
        })
    );
    phone
        .send(&ClientMessage::EditLineUp {
            request_id: line_up.request_id,
            edit: LineUpEdit::SetMic {
                seat: 0,
                mic: MicKey::Phone {
                    phone_id: phone_id(1).0,
                },
            },
        })
        .await;
    next_party(&mut phone).await;
    phone
        .send(&ClientMessage::EditLineUp {
            request_id: line_up.request_id,
            edit: LineUpEdit::SetMic {
                seat: 0,
                mic: MicKey::LocalMic {
                    local_mic_id: left.0.clone(),
                },
            },
        })
        .await;
    loop {
        match recv(&mut phone).await {
            ServerMessage::Rejected { reason } => {
                assert_eq!(reason, UserMessage::MicNotAvailable);
                break;
            }
            ServerMessage::PartyChanged { .. } => {}
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn only_the_active_stage_reports_its_local_mics_and_they_go_with_it() {
    let app = TestApp::start().await;
    let (mut stage, _) = first_stage(&app).await;
    let left = browser_mic("usb", 0);
    switch_on(&mut stage, &left).await;
    local_mics_changed(&mut stage).await;
    report(&mut stage, &[&left.0]).await;
    let party = local_mics_changed(&mut stage).await;
    assert!(party.local_mics[0].present);

    let mut phone = app.connect_ws().await;
    phone.recv().await;
    report(&mut phone, &[&left.0]).await;
    assert_eq!(
        recv(&mut phone).await,
        ServerMessage::Rejected {
            reason: UserMessage::NotTheStage
        }
    );

    // The Stage closes: its devices are no longer read.
    let mut socket = stage.into_socket();
    socket.close(None).await.unwrap();
    while socket.next().await.is_some_and(|frame| frame.is_ok()) {}
    let party = local_mics_changed(&mut phone).await;
    assert!(!party.local_mics[0].present);
}

#[tokio::test]
async fn a_bridge_local_mic_is_present_while_its_bridge_is_open() {
    let app = TestApp::start().await;
    let (mut stage, _) = first_stage(&app).await;
    let mut bridge = app.connect_ws_at("/ws/bridge").await;
    bridge.recv().await;
    bridge
        .send(&ClientMessage::BridgeHello {
            build: openstar::BUILD_ID.into(),
            host_name: "hermes".into(),
            token: None,
            interfaces: vec![BridgeInterface {
                device_name: "card".into(),
                label: "Scarlett".into(),
                channels: 2,
                usb_id: None,
                twin: false,
            }],
        })
        .await;
    let listing: openstar_protocol::bridge::MicBridges = loop {
        let listing: openstar_protocol::bridge::MicBridges = app.get_json("/api/mic-bridges").await;
        if !listing.requests.is_empty() {
            break listing;
        }
        tokio::task::yield_now().await;
    };
    stage
        .send(&ClientMessage::ApproveBridge {
            request_id: listing.requests[0].request_id,
        })
        .await;
    let bridge_id: BridgeId = loop {
        if let ServerMessage::BridgeConnected { bridge_id } = recv(&mut bridge).await {
            break bridge_id;
        }
    };
    let id = bridge_local_mic_id(&bridge_id, "card", 1);
    let source = LocalMicSource::Bridge {
        bridge_id,
        device_name: "card".into(),
        label: "Scarlett".into(),
        channel: 1,
        loopback: None,
    };
    switch_on(&mut stage, &(id.clone(), source)).await;
    let party = local_mics_changed(&mut stage).await;
    assert_eq!(listed(&party), vec![(id.clone(), String::new(), true)]);

    // The bridge's window closes.
    let mut socket = bridge.into_socket();
    socket.close(None).await.unwrap();
    while socket.next().await.is_some_and(|frame| frame.is_ok()) {}
    let party = local_mics_changed(&mut stage).await;
    assert_eq!(listed(&party), vec![(id, String::new(), false)]);
}

#[tokio::test]
async fn find_it_moves_a_seated_local_mic_with_its_seat() {
    let (app, solo) = app_with_song().await;
    let (mut stage, code) = first_stage(&app).await;
    let old = browser_mic("old", 0);
    let new = browser_mic("new", 0);
    switch_on(&mut stage, &old).await;
    local_mics_changed(&mut stage).await;
    report(&mut stage, &[&old.0]).await;
    local_mics_changed(&mut stage).await;
    let mut phone = joined_phone(&app, &code, 1).await;
    phone
        .send(&ClientMessage::AddRequest {
            song_id: solo,
            requested_players: None,
        })
        .await;
    next_party(&mut phone).await;

    stage
        .send(&ClientMessage::RelinkLocalMic {
            local_mic_id: old.0.clone(),
            new_local_mic_id: new.0.clone(),
            source: new.1.clone(),
        })
        .await;
    report(&mut stage, &[&new.0]).await;
    let party = loop {
        let party = local_mics_changed(&mut stage).await;
        if party.local_mics.first().is_some_and(|mic| mic.present) {
            break party;
        }
    };
    assert_eq!(listed(&party), vec![(new.0.clone(), String::new(), true)]);
    assert_eq!(
        party.line_up.unwrap().seats[0].mic,
        Some(MicKey::LocalMic {
            local_mic_id: new.0.clone()
        })
    );
}
