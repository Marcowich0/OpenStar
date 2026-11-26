//! What the server tells a Mic bridge about its detectors, over the real
//! app: which of its channels are switched-on Local mics seated in the Song
//! that plays (paused included), told whenever that changes and on a
//! reconnect during the Song; and the input delays a bridge reports, listed
//! per channel in `GET /api/mic-bridges`. A test client stands in for the
//! bridge.

use std::path::Path;

use openstar_protocol::bridge::{
    BridgeId, BridgeInputDelay, BridgeInterface, MicBridges, bridge_local_mic_id,
};
use openstar_protocol::library::{SongId, SongList};
use openstar_protocol::mics::{LocalMicSource, MicKey};
use openstar_protocol::profile::{Avatar, AvatarKey, PaletteKey};
use openstar_protocol::{
    BridgeInput, ChangeTopic, ClientMessage, LineUpEdit, NewGuest, PartySnapshot, RequestId,
    SeatWho, ServerMessage, SongControl,
};
use openstar_test_harness::{TestApp, WsClient};

const DEVICE: &str = "multichannel.wav";
const CHANNELS: u32 = 4;

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

fn input(channel: u32) -> BridgeInput {
    BridgeInput {
        device_name: DEVICE.into(),
        channel,
    }
}

fn hello(token: Option<String>) -> ClientMessage {
    ClientMessage::BridgeHello {
        build: openstar::BUILD_ID.into(),
        host_name: "hermes".into(),
        token,
        interfaces: vec![BridgeInterface {
            device_name: DEVICE.into(),
            label: DEVICE.into(),
            channels: CHANNELS,
            usb_id: None,
            twin: false,
        }],
    }
}

/// The next message to a bridge past the notices it gets about anything
/// else.
async fn bridge_recv(bridge: &mut WsClient) -> ServerMessage {
    loop {
        match bridge.recv().await {
            ServerMessage::Changed { .. }
            | ServerMessage::PartyChanged { .. }
            | ServerMessage::BridgeMicsScreen { .. }
            | ServerMessage::BridgeChannels { .. } => {}
            message => return message,
        }
    }
}

async fn bridge_heard_nothing(bridge: &mut WsClient) {
    bridge.send(&ClientMessage::Ping { nonce: 5 }).await;
    assert_eq!(bridge_recv(bridge).await, ServerMessage::Pong { nonce: 5 });
}

/// The Party in the next Party change on `stage`.
async fn next_party(stage: &mut WsClient) -> PartySnapshot {
    loop {
        if let ServerMessage::PartyChanged { party, .. } = stage.recv().await {
            return party;
        }
    }
}

async fn open_stage(app: &TestApp) -> WsClient {
    let mut stage = app.connect_stage().await;
    assert!(matches!(
        stage.recv().await,
        ServerMessage::LiveState { is_stage: true, .. }
    ));
    next_party(&mut stage).await;
    stage
}

/// A bridge socket that said hello with `token`.
async fn bridge_socket(app: &TestApp, token: Option<String>) -> WsClient {
    let mut bridge = app.connect_ws_at("/ws/bridge").await;
    assert!(matches!(
        bridge.recv().await,
        ServerMessage::LiveState { .. }
    ));
    bridge.send(&hello(token)).await;
    bridge
}

/// An approved, connected bridge: its socket, id and token.
async fn approved_bridge(app: &TestApp, stage: &mut WsClient) -> (WsClient, BridgeId, String) {
    let mut bridge = bridge_socket(app, None).await;
    assert!(matches!(
        bridge_recv(&mut bridge).await,
        ServerMessage::BridgeWaiting { .. }
    ));
    let listing: MicBridges = app.get_json("/api/mic-bridges").await;
    stage
        .send(&ClientMessage::ApproveBridge {
            request_id: listing.requests[0].request_id,
        })
        .await;
    let ServerMessage::BridgeApproved { token } = bridge_recv(&mut bridge).await else {
        panic!("expected BridgeApproved");
    };
    let ServerMessage::BridgeConnected { bridge_id } = bridge_recv(&mut bridge).await else {
        panic!("expected BridgeConnected");
    };
    (bridge, bridge_id, token)
}

fn local_mic(bridge_id: &BridgeId, channel: u32) -> (String, LocalMicSource) {
    (
        bridge_local_mic_id(bridge_id, DEVICE, channel),
        LocalMicSource::Bridge {
            bridge_id: bridge_id.clone(),
            device_name: DEVICE.into(),
            label: DEVICE.into(),
            channel,
            loopback: None,
        },
    )
}

/// Switches channels `channels` of the bridge on and seats a Guest on each,
/// in a Request for `song`; returns the Request.
async fn seat_bridge_mics(
    stage: &mut WsClient,
    bridge_id: &BridgeId,
    song: SongId,
    channels: &[u32],
) -> RequestId {
    for &channel in channels {
        let (local_mic_id, source) = local_mic(bridge_id, channel);
        stage
            .send(&ClientMessage::SetLocalMicSwitchedOn {
                local_mic_id,
                source,
                switched_on: true,
            })
            .await;
    }
    stage
        .send(&ClientMessage::AddRequest {
            song_id: song,
            requested_players: None,
        })
        .await;
    let request_id = loop {
        if let Some(line_up) = next_party(stage).await.line_up {
            break line_up.request_id;
        }
    };
    for (seat, &channel) in channels.iter().enumerate() {
        stage
            .send(&ClientMessage::EditLineUp {
                request_id,
                edit: LineUpEdit::AddSeat {
                    who: SeatWho::Guest(NewGuest {
                        name: format!("Guest {seat}"),
                        colour: PaletteKey::ALL[seat],
                        avatar: Avatar::BuiltIn {
                            key: AvatarKey::Star,
                        },
                    }),
                },
            })
            .await;
        stage
            .send(&ClientMessage::EditLineUp {
                request_id,
                edit: LineUpEdit::SetMic {
                    seat: seat as u32,
                    mic: MicKey::LocalMic {
                        local_mic_id: local_mic(bridge_id, channel).0,
                    },
                },
            })
            .await;
    }
    // Every edit is answered by a Party change; the last one shows the seats.
    loop {
        let party = next_party(stage).await;
        let seated: Vec<Option<MicKey>> = party
            .line_up
            .iter()
            .flat_map(|line_up| line_up.seats.iter().map(|seat| seat.mic.clone()))
            .collect();
        let wanted: Vec<Option<MicKey>> = channels
            .iter()
            .map(|&channel| {
                Some(MicKey::LocalMic {
                    local_mic_id: local_mic(bridge_id, channel).0,
                })
            })
            .collect();
        if seated == wanted {
            return request_id;
        }
    }
}

fn control(request_id: RequestId, control: SongControl) -> ClientMessage {
    ClientMessage::ControlSong {
        request_id,
        control,
    }
}

#[tokio::test]
async fn a_bridge_is_told_its_channels_seated_in_the_playing_song_until_the_song_stops() {
    let (app, song) = app_with_song().await;
    let mut stage = open_stage(&app).await;
    let (mut bridge, bridge_id, _) = approved_bridge(&app, &mut stage).await;

    // Seated but not playing: nothing detects.
    let request = seat_bridge_mics(&mut stage, &bridge_id, song, &[2, 0]).await;
    bridge_heard_nothing(&mut bridge).await;

    // The Song starts: both seated channels detect, in channel order.
    stage.send(&control(request, SongControl::Start)).await;
    assert_eq!(
        bridge_recv(&mut bridge).await,
        ServerMessage::BridgeDetecting {
            channels: vec![input(0), input(2)]
        }
    );

    // Paused, it still plays: nothing changes.
    stage.send(&control(request, SongControl::Pause)).await;
    next_party(&mut stage).await;
    bridge_heard_nothing(&mut bridge).await;

    // Skipped: no channel detects any more.
    stage.send(&control(request, SongControl::Skip)).await;
    assert_eq!(
        bridge_recv(&mut bridge).await,
        ServerMessage::BridgeDetecting { channels: vec![] }
    );
}

#[tokio::test]
async fn a_bridge_that_connects_again_during_the_song_is_told_at_once() {
    let (app, song) = app_with_song().await;
    let mut stage = open_stage(&app).await;
    let (bridge, bridge_id, token) = approved_bridge(&app, &mut stage).await;
    let request = seat_bridge_mics(&mut stage, &bridge_id, song, &[1]).await;
    stage.send(&control(request, SongControl::Start)).await;
    drop(bridge);

    let mut again = bridge_socket(&app, Some(token)).await;
    assert!(matches!(
        bridge_recv(&mut again).await,
        ServerMessage::BridgeConnected { .. }
    ));
    assert_eq!(
        bridge_recv(&mut again).await,
        ServerMessage::BridgeDetecting {
            channels: vec![input(1)]
        }
    );
}

#[tokio::test]
async fn reported_input_delays_are_listed_per_channel_and_others_are_dropped() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let (mut bridge, _, _) = approved_bridge(&app, &mut stage).await;
    let listing: MicBridges = app.get_json("/api/mic-bridges").await;
    assert!(
        listing.bridges[0]
            .channels
            .iter()
            .all(|c| c.reported_input_delay_ms.is_none())
    );

    let delay = |channel, delay_ms| BridgeInputDelay {
        device_name: DEVICE.into(),
        channel,
        delay_ms,
    };
    bridge
        .send(&ClientMessage::BridgeInputDelays {
            delays: vec![delay(1, 4.5), delay(CHANNELS, 9.0)],
        })
        .await;
    loop {
        if stage.recv().await
            == (ServerMessage::Changed {
                topics: vec![ChangeTopic::MicBridges],
            })
        {
            break;
        }
    }
    let listing: MicBridges = app.get_json("/api/mic-bridges").await;
    let delays: Vec<Option<f64>> = listing.bridges[0]
        .channels
        .iter()
        .map(|c| c.reported_input_delay_ms)
        .collect();
    assert_eq!(delays, vec![None, Some(4.5), None, None]);
}
