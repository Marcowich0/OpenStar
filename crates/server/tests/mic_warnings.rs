//! Mic warnings and lost Local mics, over the real app (v1 spec #51, "Mic
//! warnings" and "Unplugged, closed and back"): a seated Local mic of a
//! closed Mic bridge warns "<host> mic bridge is closed" and keeps its seat;
//! the Stage's digital-silence report warns under the seat; neither blocks
//! Start; and during a Song a closing bridge tells the Stage its Local mics
//! closed at once while the Song plays on. A test client stands in for the
//! bridge.

use std::path::Path;

use openstar_protocol::bridge::{BridgeId, BridgeInterface, MicBridges, bridge_local_mic_id};
use openstar_protocol::library::{SongId, SongList};
use openstar_protocol::mics::{LocalMicSource, MicKey};
use openstar_protocol::profile::{Avatar, AvatarKey, PaletteKey};
use openstar_protocol::{
    ClientMessage, LineUp, LineUpEdit, LineUpWarning, MicId, NewGuest, PartyMemberId,
    PartySnapshot, RequestId, SeatWho, ServerMessage, SongControl,
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

/// The Line-up of the next Party change that satisfies `wanted`.
async fn line_up_where(stage: &mut WsClient, wanted: impl Fn(&LineUp) -> bool) -> LineUp {
    loop {
        if let Some(line_up) = next_party(stage).await.line_up
            && wanted(&line_up)
        {
            return line_up;
        }
    }
}

#[tokio::test]
async fn a_seated_local_mic_of_a_closed_bridge_keeps_its_seat_and_warns_without_blocking_start() {
    let (app, song) = app_with_song().await;
    let mut stage = open_stage(&app).await;
    let (bridge, bridge_id, token) = approved_bridge(&app, &mut stage).await;
    seat_bridge_mics(&mut stage, &bridge_id, song, &[1]).await;
    let mic = local_mic(&bridge_id, 1).0;

    drop(bridge);
    let line_up = line_up_where(&mut stage, |l| !l.warnings.is_empty()).await;
    let member_id: PartyMemberId = line_up.seats[0].member_id;
    assert_eq!(
        line_up.seats[0].mic,
        Some(MicKey::LocalMic {
            local_mic_id: mic.clone()
        })
    );
    assert_eq!(
        line_up.warnings,
        vec![LineUpWarning::BridgeClosed {
            member_id,
            local_mic_id: mic.clone(),
            host_name: "hermes".into(),
        }]
    );
    assert!(line_up.can_start);

    // Back: the warning goes, the seat never moved.
    let mut again = bridge_socket(&app, Some(token)).await;
    assert!(matches!(
        bridge_recv(&mut again).await,
        ServerMessage::BridgeConnected { .. }
    ));
    let line_up = line_up_where(&mut stage, |l| l.warnings.is_empty()).await;
    assert_eq!(
        line_up.seats[0].mic,
        Some(MicKey::LocalMic { local_mic_id: mic })
    );
}

#[tokio::test]
async fn the_stages_digital_silence_report_warns_under_the_seat_until_it_sounds_again() {
    let (app, song) = app_with_song().await;
    let mut stage = open_stage(&app).await;
    let (_bridge, bridge_id, _) = approved_bridge(&app, &mut stage).await;
    seat_bridge_mics(&mut stage, &bridge_id, song, &[0]).await;
    let mic = local_mic(&bridge_id, 0).0;

    stage
        .send(&ClientMessage::ReportSilentLocalMics {
            local_mic_ids: vec![mic.clone()],
        })
        .await;
    let line_up = line_up_where(&mut stage, |l| !l.warnings.is_empty()).await;
    assert_eq!(
        line_up.warnings,
        vec![LineUpWarning::LocalMicSilent {
            member_id: line_up.seats[0].member_id,
            local_mic_id: mic,
        }]
    );
    assert!(line_up.can_start);

    stage
        .send(&ClientMessage::ReportSilentLocalMics {
            local_mic_ids: vec![],
        })
        .await;
    line_up_where(&mut stage, |l| l.warnings.is_empty()).await;
}

#[tokio::test]
async fn a_bridge_closing_during_a_song_tells_the_stage_its_seated_local_mic_closed_and_the_song_plays_on()
 {
    let (app, song) = app_with_song().await;
    let mut stage = open_stage(&app).await;
    let (bridge, bridge_id, _) = approved_bridge(&app, &mut stage).await;
    let request = seat_bridge_mics(&mut stage, &bridge_id, song, &[2]).await;
    stage.send(&control(request, SongControl::Start)).await;
    loop {
        if next_party(&mut stage).await.playing.is_some() {
            break;
        }
    }

    drop(bridge);
    let closed = MicId::Bridge {
        bridge_id: bridge_id.clone(),
        local_mic_id: local_mic(&bridge_id, 2).0,
    };
    loop {
        match stage.recv().await {
            ServerMessage::MicClosed { mic } if mic == closed => break,
            ServerMessage::PartyChanged { party, .. } => {
                assert!(party.playing.is_some(), "the Song never stops");
            }
            _ => {}
        }
    }
    let party = next_party(&mut stage).await;
    assert!(party.playing.is_some());
    assert_eq!(
        party.line_up.unwrap().seats[0].mic,
        Some(MicKey::LocalMic {
            local_mic_id: local_mic(&bridge_id, 2).0
        })
    );
}
