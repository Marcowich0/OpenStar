//! A Mic bridge joins the Stage, over the real app: it says hello on
//! `/ws/bridge`, waits for approval with a 4-digit code, the Stage approves
//! it with no Admin PIN, and its approval token lets it straight back in on
//! later connects and after a server restart. The Stage switches its
//! channels on and the server tells the bridge.

use openstar_protocol::bridge::{
    BridgeChannelSettings, BridgeId, BridgeInterface, BridgeRequest, MicBridges,
    bridge_local_mic_id,
};
use openstar_protocol::mics::{LocalMic, LocalMicSource};
use openstar_protocol::{ChangeTopic, ClientMessage, ServerMessage, UserMessage};
use openstar_test_harness::{TestApp, WsClient};

fn wav_interface() -> BridgeInterface {
    BridgeInterface {
        device_name: "multichannel.wav".into(),
        label: "multichannel.wav".into(),
        channels: 4,
    }
}

fn hello(host_name: &str, token: Option<&str>) -> ClientMessage {
    ClientMessage::BridgeHello {
        build: openstar::BUILD_ID.into(),
        host_name: host_name.into(),
        token: token.map(Into::into),
        interfaces: vec![wav_interface()],
    }
}

/// Opens the Stage on a fresh server, past its live state and the Party it
/// started.
async fn open_stage(app: &TestApp) -> WsClient {
    let mut stage = app.connect_stage().await;
    assert!(matches!(
        stage.recv().await,
        ServerMessage::LiveState { is_stage: true, .. }
    ));
    assert!(matches!(
        stage.recv().await,
        ServerMessage::PartyChanged { .. }
    ));
    stage
}

/// Opens a bridge socket, past its live state.
async fn connect_bridge(app: &TestApp) -> WsClient {
    let mut bridge = app.connect_ws_at("/ws/bridge").await;
    assert!(matches!(
        bridge.recv().await,
        ServerMessage::LiveState {
            is_stage: false,
            ..
        }
    ));
    bridge
}

/// The next message meant for a bridge, past the notices every socket
/// gets (a bridge ignores them).
async fn bridge_recv(bridge: &mut WsClient) -> ServerMessage {
    loop {
        match bridge.recv().await {
            ServerMessage::Changed { .. }
            | ServerMessage::PartyChanged { .. }
            | ServerMessage::BridgeMicsScreen { .. } => {}
            message => return message,
        }
    }
}

async fn expect_bridges_changed(socket: &mut WsClient) {
    assert_eq!(
        socket.recv().await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::MicBridges]
        }
    );
}

async fn mic_bridges(app: &TestApp) -> MicBridges {
    app.get_json("/api/mic-bridges").await
}

/// Says hello without a token and returns the code it waits with.
async fn wait_for_approval(bridge: &mut WsClient, host_name: &str) -> String {
    bridge.send(&hello(host_name, None)).await;
    match bridge_recv(bridge).await {
        ServerMessage::BridgeWaiting { code } => code,
        other => panic!("expected BridgeWaiting, got {other:?}"),
    }
}

/// Approves the one waiting request and returns the bridge's token and id.
async fn approve(app: &TestApp, stage: &mut WsClient, bridge: &mut WsClient) -> (String, BridgeId) {
    let requests = mic_bridges(app).await.requests;
    let [request] = requests.as_slice() else {
        panic!("expected one request, got {requests:?}");
    };
    stage
        .send(&ClientMessage::ApproveBridge {
            request_id: request.request_id,
        })
        .await;
    let token = match bridge_recv(bridge).await {
        ServerMessage::BridgeApproved { token } => token,
        other => panic!("expected BridgeApproved, got {other:?}"),
    };
    let bridge_id = match bridge_recv(bridge).await {
        ServerMessage::BridgeConnected { bridge_id } => bridge_id,
        other => panic!("expected BridgeConnected, got {other:?}"),
    };
    (token, bridge_id)
}

fn all_off(bridge_id: &BridgeId) -> Vec<BridgeChannelSettings> {
    (0..4)
        .map(|channel| BridgeChannelSettings {
            device_name: "multichannel.wav".into(),
            channel,
            local_mic_id: bridge_local_mic_id(bridge_id, "multichannel.wav", channel),
            switched_on: false,
            name: String::new(),
        })
        .collect()
}

async fn expect_channels(bridge: &mut WsClient) -> Vec<BridgeChannelSettings> {
    match bridge_recv(bridge).await {
        ServerMessage::BridgeChannels { channels } => channels,
        other => panic!("expected BridgeChannels, got {other:?}"),
    }
}

#[tokio::test]
async fn a_new_bridge_waits_with_a_code_the_stage_sees_and_approves_without_a_pin() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut bridge = connect_bridge(&app).await;

    let code = wait_for_approval(&mut bridge, "hermes").await;
    assert_eq!(code.len(), 4);
    assert!(code.chars().all(|c| c.is_ascii_digit()), "{code}");
    expect_bridges_changed(&mut stage).await;
    let listed = mic_bridges(&app).await;
    assert_eq!(listed.bridges, vec![]);
    assert_eq!(
        listed
            .requests
            .iter()
            .map(|r| (r.host_name.as_str(), r.code.as_str()))
            .collect::<Vec<_>>(),
        vec![("hermes", code.as_str())]
    );

    // No Unlock anywhere: the Stage approves.
    let (token, bridge_id) = approve(&app, &mut stage, &mut bridge).await;
    assert!(token.len() >= 32, "a long random token: {token}");
    assert_ne!(bridge_id.0, token, "the token is never the public id");
    assert_eq!(expect_channels(&mut bridge).await, all_off(&bridge_id));
    expect_bridges_changed(&mut stage).await;

    let listed = mic_bridges(&app).await;
    assert_eq!(listed.requests, vec![]);
    let [approved] = listed.bridges.as_slice() else {
        panic!("one approved bridge: {listed:?}");
    };
    assert_eq!(approved.host_name, "hermes");
    assert!(approved.open);
    assert_eq!(approved.bridge_id, bridge_id);
    assert_eq!(
        approved
            .channels
            .iter()
            .map(|c| c.local_mic_id.clone())
            .collect::<Vec<_>>(),
        (0..4)
            .map(|n| bridge_local_mic_id(&bridge_id, "multichannel.wav", n))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        approved.channels[2].source,
        LocalMicSource::Bridge {
            bridge_id: bridge_id.clone(),
            device_name: "multichannel.wav".into(),
            label: "multichannel.wav".into(),
            channel: 2,
        }
    );
    let text = serde_json::to_string(&listed).unwrap();
    assert!(!text.contains(&token), "the token is never listed");
}

#[tokio::test]
async fn only_the_stage_may_approve_a_bridge() {
    let app = TestApp::start().await;
    let _stage = open_stage(&app).await;
    let mut phone = app.connect_ws().await;
    let _ = phone.recv().await;
    let mut bridge = connect_bridge(&app).await;
    wait_for_approval(&mut bridge, "hermes").await;
    expect_bridges_changed(&mut phone).await;
    let requests = mic_bridges(&app).await.requests;
    let [BridgeRequest { request_id, .. }] = requests.as_slice() else {
        panic!("one request");
    };

    phone
        .send(&ClientMessage::ApproveBridge {
            request_id: *request_id,
        })
        .await;
    assert_eq!(
        phone.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::NotTheStage
        }
    );
    assert_eq!(mic_bridges(&app).await.bridges, vec![]);
}

#[tokio::test]
async fn approving_a_request_that_is_gone_is_refused() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut bridge = connect_bridge(&app).await;
    wait_for_approval(&mut bridge, "hermes").await;
    expect_bridges_changed(&mut stage).await;
    let request_id = mic_bridges(&app).await.requests[0].request_id;
    bridge.into_socket().close(None).await.unwrap();
    expect_bridges_changed(&mut stage).await;
    assert_eq!(mic_bridges(&app).await.requests, vec![]);

    stage
        .send(&ClientMessage::ApproveBridge { request_id })
        .await;
    assert_eq!(
        stage.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::BridgeRequestNotFound
        }
    );
}

#[tokio::test]
async fn the_token_lets_an_approved_bridge_straight_back_in_and_it_stays_approved_while_closed() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut bridge = connect_bridge(&app).await;
    wait_for_approval(&mut bridge, "hermes").await;
    expect_bridges_changed(&mut stage).await;
    let (token, bridge_id) = approve(&app, &mut stage, &mut bridge).await;
    expect_channels(&mut bridge).await;
    expect_bridges_changed(&mut stage).await;

    bridge.into_socket().close(None).await.unwrap();
    expect_bridges_changed(&mut stage).await;
    let closed = mic_bridges(&app).await;
    assert_eq!(closed.requests, vec![]);
    assert!(!closed.bridges[0].open, "closed, still approved");
    assert_eq!(closed.bridges[0].channels, vec![]);

    let mut again = connect_bridge(&app).await;
    again.send(&hello("hermes", Some(&token))).await;
    assert_eq!(
        bridge_recv(&mut again).await,
        ServerMessage::BridgeConnected {
            bridge_id: bridge_id.clone()
        }
    );
    assert_eq!(expect_channels(&mut again).await, all_off(&bridge_id));
    expect_bridges_changed(&mut stage).await;
    assert!(mic_bridges(&app).await.bridges[0].open);
}

#[tokio::test]
async fn a_bridge_without_a_valid_token_never_reaches_the_approved_state() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;

    let mut bridge = connect_bridge(&app).await;
    bridge
        .send(&hello("hermes", Some("not-a-token-the-server-gave")))
        .await;
    assert!(matches!(
        bridge_recv(&mut bridge).await,
        ServerMessage::BridgeWaiting { .. }
    ));
    expect_bridges_changed(&mut stage).await;
    assert_eq!(mic_bridges(&app).await.bridges, vec![]);
    assert_eq!(mic_bridges(&app).await.requests.len(), 1);

    // A browser socket cannot say hello as a bridge.
    let mut browser = app.connect_ws().await;
    let _ = browser.recv().await;
    browser.send(&hello("mallory", None)).await;
    assert_eq!(
        browser.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::NotABridge
        }
    );
    assert_eq!(mic_bridges(&app).await.requests.len(), 1);
}

#[tokio::test]
async fn an_approved_bridge_reconnects_without_approval_after_a_server_restart() {
    let mut app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut bridge = connect_bridge(&app).await;
    wait_for_approval(&mut bridge, "hermes").await;
    expect_bridges_changed(&mut stage).await;
    let (token, bridge_id) = approve(&app, &mut stage, &mut bridge).await;

    app.restart().await;

    let closed = mic_bridges(&app).await;
    assert_eq!(closed.bridges.len(), 1);
    assert!(!closed.bridges[0].open);
    assert_eq!(closed.bridges[0].host_name, "hermes");
    let mut again = connect_bridge(&app).await;
    again.send(&hello("hermes", Some(&token))).await;
    assert_eq!(
        bridge_recv(&mut again).await,
        ServerMessage::BridgeConnected { bridge_id }
    );
}

#[tokio::test]
async fn bridges_are_listed_in_order_of_approval() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut first = connect_bridge(&app).await;
    let mut second = connect_bridge(&app).await;
    wait_for_approval(&mut first, "zeus").await;
    expect_bridges_changed(&mut stage).await;
    wait_for_approval(&mut second, "apollo").await;
    expect_bridges_changed(&mut stage).await;

    // Approve apollo first, though it asked second.
    let requests = mic_bridges(&app).await.requests;
    assert_eq!(requests.len(), 2);
    assert_ne!(requests[0].code, requests[1].code, "codes differ");
    let apollo = requests.iter().find(|r| r.host_name == "apollo").unwrap();
    stage
        .send(&ClientMessage::ApproveBridge {
            request_id: apollo.request_id,
        })
        .await;
    expect_bridges_changed(&mut stage).await;
    let zeus = mic_bridges(&app).await.requests[0].request_id;
    stage
        .send(&ClientMessage::ApproveBridge { request_id: zeus })
        .await;
    expect_bridges_changed(&mut stage).await;

    let names: Vec<String> = mic_bridges(&app)
        .await
        .bridges
        .into_iter()
        .map(|b| b.host_name)
        .collect();
    assert_eq!(names, ["apollo", "zeus"]);
}

#[tokio::test]
async fn the_server_tells_the_bridge_which_channels_the_stage_switched_on() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut bridge = connect_bridge(&app).await;
    wait_for_approval(&mut bridge, "hermes").await;
    expect_bridges_changed(&mut stage).await;
    let (_, bridge_id) = approve(&app, &mut stage, &mut bridge).await;
    expect_channels(&mut bridge).await;
    expect_bridges_changed(&mut stage).await;

    let channel = mic_bridges(&app).await.bridges[0].channels[1].clone();
    stage
        .send(&ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: channel.local_mic_id.clone(),
            source: channel.source.clone(),
            switched_on: true,
        })
        .await;
    assert_eq!(
        stage.recv().await,
        ServerMessage::Changed {
            topics: vec![ChangeTopic::MicSettings]
        }
    );
    let mut expected = all_off(&bridge_id);
    expected[1].switched_on = true;
    assert_eq!(expect_channels(&mut bridge).await, expected);

    let kept: Vec<LocalMic> = app.get_json("/api/local-mics").await;
    assert_eq!(
        kept,
        vec![LocalMic {
            local_mic_id: channel.local_mic_id,
            source: channel.source,
            name: String::new(),
            switched_on: true,
        }]
    );
}

#[tokio::test]
async fn a_bridge_local_mic_id_that_does_not_match_its_source_is_refused() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    stage
        .send(&ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: "bridge:someone-else:x:0".into(),
            source: LocalMicSource::Bridge {
                bridge_id: BridgeId("ab".into()),
                device_name: "multichannel.wav".into(),
                label: "multichannel.wav".into(),
                channel: 0,
            },
            switched_on: true,
        })
        .await;
    assert_eq!(
        stage.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::InvalidMessage
        }
    );
}

#[tokio::test]
async fn a_rename_and_a_find_it_reach_the_bridge_like_a_switch() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let mut bridge = connect_bridge(&app).await;
    wait_for_approval(&mut bridge, "hermes").await;
    expect_bridges_changed(&mut stage).await;
    let (_, bridge_id) = approve(&app, &mut stage, &mut bridge).await;
    expect_channels(&mut bridge).await;
    expect_bridges_changed(&mut stage).await;
    let channels = mic_bridges(&app).await.bridges[0].channels.clone();
    let mic_settings_changed = ServerMessage::Changed {
        topics: vec![ChangeTopic::MicSettings],
    };

    // Naming a channel is saved the same way as switching it on.
    stage
        .send(&ClientMessage::SetLocalMicName {
            local_mic_id: channels[0].local_mic_id.clone(),
            source: channels[0].source.clone(),
            name: "  Red mic ".into(),
        })
        .await;
    assert_eq!(stage.recv().await, mic_settings_changed);
    let mut expected = all_off(&bridge_id);
    expected[0].name = "Red mic".into();
    assert_eq!(expect_channels(&mut bridge).await, expected);

    // Find it moves a switched-on browser Local mic to bridge channel 2.
    let browser = LocalMicSource::Browser {
        stage_browser: "stage".into(),
        device_id: "dongle".into(),
        label: "USB Audio".into(),
        channel: 0,
        stereo: false,
    };
    stage
        .send(&ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: "browser:stage:dongle:0".into(),
            source: browser.clone(),
            switched_on: true,
        })
        .await;
    assert_eq!(stage.recv().await, mic_settings_changed);
    stage
        .send(&ClientMessage::SetLocalMicName {
            local_mic_id: "browser:stage:dongle:0".into(),
            source: browser,
            name: "Blue mic".into(),
        })
        .await;
    assert_eq!(stage.recv().await, mic_settings_changed);
    assert_eq!(expect_channels(&mut bridge).await, expected);
    assert_eq!(expect_channels(&mut bridge).await, expected);
    stage
        .send(&ClientMessage::RelinkLocalMic {
            local_mic_id: "browser:stage:dongle:0".into(),
            new_local_mic_id: channels[2].local_mic_id.clone(),
            source: channels[2].source.clone(),
        })
        .await;
    assert_eq!(stage.recv().await, mic_settings_changed);
    expected[2].name = "Blue mic".into();
    expected[2].switched_on = true;
    assert_eq!(expect_channels(&mut bridge).await, expected);
}

#[tokio::test]
async fn a_rename_or_find_it_whose_bridge_id_does_not_match_its_source_is_refused() {
    let app = TestApp::start().await;
    let mut stage = open_stage(&app).await;
    let source = LocalMicSource::Bridge {
        bridge_id: BridgeId("ab".into()),
        device_name: "multichannel.wav".into(),
        label: "multichannel.wav".into(),
        channel: 0,
    };
    stage
        .send(&ClientMessage::SetLocalMicName {
            local_mic_id: "bridge:someone-else:x:0".into(),
            source: source.clone(),
            name: "Red mic".into(),
        })
        .await;
    assert_eq!(
        stage.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::InvalidMessage
        }
    );
    stage
        .send(&ClientMessage::RelinkLocalMic {
            local_mic_id: "browser:stage:dongle:0".into(),
            new_local_mic_id: "bridge:someone-else:x:0".into(),
            source,
        })
        .await;
    assert_eq!(
        stage.recv().await,
        ServerMessage::Rejected {
            reason: UserMessage::InvalidMessage
        }
    );
    let kept: Vec<LocalMic> = app.get_json("/api/local-mics").await;
    assert_eq!(kept, vec![]);
}
