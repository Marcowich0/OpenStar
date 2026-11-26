//! The bridge's window without a display: its states drawn by a software
//! renderer and compared with the baselines in `tests/snapshots/` (only
//! `just update-screenshots` writes those), no control but Switch to Pro
//! Audio and its Copy, the
//! rule that the bridge is connected only while the window is open, and
//! that the binary links no graphics library.

#[path = "window/cpu_renderer.rs"]
mod cpu_renderer;

use std::sync::mpsc;
use std::time::{Duration, Instant};

use egui::accesskit::Role;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable as _;
use openstar_mic_bridge::client::{self, Event, Input};
use openstar_mic_bridge::config::ConfigDir;
use openstar_mic_bridge::update::{self, Plan};
use openstar_mic_bridge::wav;
use openstar_mic_bridge::window::state::{Status, WindowState};
use openstar_mic_bridge::window::{self, Shared, view};
use openstar_protocol::ClientMessage;
use openstar_protocol::ServerMessage;
use openstar_protocol::bridge::{
    BridgeChannelSettings, BridgeId, BridgeInterface, MicBridges, NotProAudio,
};
use openstar_test_harness::{TestApp, fake_mic};

const SERVER: &str = "http://openstar.lan:8080";
const DEVICE: &str = "alsa_card.usb-Focusrite_Scarlett_4i4_4th_Gen-00";

fn scarlett() -> Vec<BridgeInterface> {
    vec![BridgeInterface {
        device_name: DEVICE.into(),
        label: "Scarlett 4i4".into(),
        channels: 4,
        usb_id: None,
        twin: false,
    }]
}

fn harness(state: WindowState) -> Harness<'static> {
    pressing(state, std::rc::Rc::default())
}

/// The window, keeping every press it reports in `presses`.
fn pressing(
    state: WindowState,
    presses: std::rc::Rc<std::cell::RefCell<Vec<view::Pressed>>>,
) -> Harness<'static> {
    let mut harness = Harness::builder()
        .with_size(egui::Vec2::from(view::WINDOW_SIZE))
        .renderer(cpu_renderer::CpuRenderer::default())
        .build_ui(move |ui| {
            view::set_style(ui.ctx());
            if let Some(pressed) = view::show(ui, &state) {
                presses.borrow_mut().push(pressed);
            }
        });
    harness.run();
    harness
}

/// Compares with the baseline. `UPDATE_SNAPSHOTS` alone does not write
/// baselines: `just update-screenshots` sets both variables.
fn snapshot(harness: &mut Harness<'_>, name: &str) {
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some()
        && std::env::var("OPENSTAR_UPDATE_SCREENSHOTS").as_deref() != Ok("1")
    {
        panic!("the bridge window baselines change only through `just update-screenshots`");
    }
    harness.snapshot(name);
}

fn settings(channel: u32, switched_on: bool, name: &str) -> BridgeChannelSettings {
    BridgeChannelSettings {
        device_name: DEVICE.into(),
        channel,
        local_mic_id: format!("bridge:b:{DEVICE}:{channel}"),
        switched_on,
        name: name.into(),
    }
}

fn waiting() -> WindowState {
    let mut state = WindowState::new(SERVER, scarlett());
    state.apply(Event::Received(&ServerMessage::BridgeWaiting {
        code: "4821".into(),
    }));
    state
}

fn connected() -> WindowState {
    let mut state = waiting();
    state.apply(Event::Received(&ServerMessage::BridgeConnected {
        bridge_id: BridgeId("b".into()),
    }));
    state.apply(Event::Received(&ServerMessage::BridgeChannels {
        channels: vec![
            settings(0, true, "Red mic"),
            settings(1, true, ""),
            settings(2, false, "Blue mic"),
            settings(3, false, ""),
        ],
    }));
    state.apply(Event::InterfaceOpen {
        device_name: DEVICE,
        open: true,
    });
    state.apply(Event::Levels {
        device_name: DEVICE,
        levels_dbfs: &[-12.0, -35.0, -100.0, -3.0],
    });
    state
}

#[test]
fn connecting_shows_the_server_and_every_channel_by_its_default_name() {
    let mut harness = harness(WindowState::new(SERVER, scarlett()));
    harness.get_by_label("Server: http://openstar.lan:8080");
    harness.get_by_label("Connecting…");
    harness.get_by_label("Scarlett 4i4 · Input 4");
    snapshot(&mut harness, "connecting");
}

#[test]
fn waiting_for_approval_shows_the_code() {
    let mut harness = harness(waiting());
    harness.get_by_label("Waiting for approval");
    harness.get_by_label("4821");
    snapshot(&mut harness, "waiting-for-approval");
}

#[test]
fn connected_shows_each_channel_with_its_name_on_or_off_and_its_meter() {
    let mut harness = harness(connected());
    harness.get_by_label("Connected");
    harness.get_by_label("Red mic");
    harness.get_by_label("Scarlett 4i4 · Input 2");
    harness.get_by_label("Blue mic");
    assert_eq!(harness.query_all_by_label("On").count(), 2);
    assert_eq!(harness.query_all_by_label("Off").count(), 2);
    snapshot(&mut harness, "connected");
}

fn updating() -> WindowState {
    let mut state = connected();
    state.apply(Event::Updating { build: "1.4.0" });
    state
}

fn build_mismatch() -> WindowState {
    let Plan::Mismatch(mismatch) = update::plan("1.3.2", "1.4.0", SERVER, false) else {
        panic!("a mismatch");
    };
    let mut state = WindowState::new(SERVER, scarlett());
    state.apply(Event::BuildMismatch(&mismatch));
    state
}

#[test]
fn updating_shows_the_build_it_updates_to_and_no_prompt() {
    let mut harness = harness(updating());
    harness.get_by_label("Updating to 1.4.0…");
    snapshot(&mut harness, "updating");
}

#[test]
fn a_bridge_that_cannot_update_itself_shows_both_builds_and_the_install_command() {
    let mut harness = harness(build_mismatch());
    harness.get_by_label("This Mic bridge is 1.3.2, the server is 1.4.0");
    harness.get_by_label("curl -fsSL http://openstar.lan:8080/bridge/install.sh | sh");
    snapshot(&mut harness, "build-mismatch");
}

const OTHER: &str = "alsa_card.usb-BEHRINGER_UMC404HD_192k-00";

fn umc_in_hifi(switch_refused: bool) -> NotProAudio {
    NotProAudio {
        device_name: OTHER.into(),
        card_name: OTHER.into(),
        label: "UMC404HD 192k".into(),
        profile: "HiFi".into(),
        switch_refused,
    }
}

/// Connected, with the Scarlett in Pro Audio and the UMC404HD in UCM HiFi.
fn not_pro_audio(switch_refused: bool) -> WindowState {
    let mut state = connected();
    state.apply(Event::Offered {
        interfaces: &scarlett(),
        not_pro_audio: &[umc_in_hifi(switch_refused)],
    });
    state
}

#[test]
fn an_interface_not_in_pro_audio_says_so_with_switch_to_pro_audio_ahead_of_the_channels() {
    let mut harness = harness(not_pro_audio(false));
    let message = harness.get_by_label("UMC404HD 192k is in HiFi: only some inputs reach OpenStar");
    let button = harness.get_by_label("Switch to Pro Audio");
    let channel = harness.get_by_label("Red mic");
    assert!(
        message.rect().top() < channel.rect().top(),
        "the message comes first"
    );
    assert!(button.rect().top() < channel.rect().top());
    snapshot(&mut harness, "not-pro-audio");
}

#[test]
fn pressing_switch_to_pro_audio_asks_for_that_interface() {
    let presses = std::rc::Rc::default();
    let mut harness = pressing(not_pro_audio(false), std::rc::Rc::clone(&presses));
    harness.get_by_label("Switch to Pro Audio").click();
    harness.run();
    assert_eq!(
        *presses.borrow(),
        vec![view::Pressed::SwitchToProAudio(OTHER.into())]
    );
}

#[test]
fn a_refused_switch_says_to_use_the_sound_settings_with_the_pactl_line_to_copy() {
    let mut harness = harness(not_pro_audio(true));
    harness.get_by_label("UMC404HD 192k is in HiFi: only some inputs reach OpenStar");
    harness.get_by_label("Set its profile to Pro Audio in your sound settings, or run:");
    harness.get_by_label(&format!("pactl set-card-profile {OTHER} pro-audio"));
    assert!(harness.query_by_label("Switch to Pro Audio").is_none());
    harness.get_by_label("Copy");
    snapshot(&mut harness, "switch-refused");
}

#[test]
fn the_only_controls_are_switch_to_pro_audio_and_its_copy() {
    for (state, buttons) in [
        (WindowState::new(SERVER, scarlett()), 0),
        (waiting(), 0),
        (connected(), 0),
        (updating(), 0),
        (build_mismatch(), 0),
        (not_pro_audio(false), 1),
        (not_pro_audio(true), 1),
    ] {
        let harness = harness(state);
        assert_eq!(harness.query_all_by_role(Role::Button).count(), buttons);
        for role in [
            Role::CheckBox,
            Role::Switch,
            Role::Slider,
            Role::SpinButton,
            Role::TextInput,
            Role::ComboBox,
            Role::Link,
        ] {
            assert_eq!(
                harness.query_all_by_role(role).count(),
                0,
                "a {role:?} in the window"
            );
        }
    }
}

#[test]
fn without_a_server_address_the_window_says_so() {
    let mut state = WindowState::new("", scarlett());
    state.stop("no server address in /home/me/.config/openstar-mic-bridge/server");
    let harness = harness(state);
    harness.get_by_label("Not running");
}

/// Waits up to 10 s for `check` to hold on what the window shows.
fn wait_for(shared: &Shared, what: &str, check: impl Fn(&WindowState) -> bool) -> WindowState {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let state = shared.snapshot();
        if check(&state) {
            return state;
        }
        assert!(Instant::now() < deadline, "no {what}: {:?}", state.status());
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_bridge_is_connected_only_while_its_window_is_open() {
    let app = TestApp::start().await;
    let mic = tempfile::tempdir().unwrap();
    let wav_file = fake_mic::write(mic.path()).unwrap().multichannel;
    let config_dir = tempfile::tempdir().unwrap();
    std::fs::write(config_dir.path().join("server"), app.base_url()).unwrap();
    let mut stage = app.connect_stage().await;

    let audio = wav::read_audio(std::io::BufReader::new(
        std::fs::File::open(&wav_file).unwrap(),
    ))
    .unwrap();
    let input = wav::WavInput::new("multichannel.wav".into(), audio);
    let interfaces = vec![input.interface().clone()];
    let shared = Shared::new(WindowState::new(app.base_url(), interfaces));
    let config = ConfigDir::at(config_dir.path().to_owned());
    let connection = {
        let mut report = shared.clone();
        async move {
            let inputs: Vec<Box<dyn Input>> = vec![Box::new(input)];
            let ended = client::run_reporting(config, inputs, &mut report).await;
            panic!("the same build never stops connecting: {ended:?}");
        }
    };

    // The "window" stays open until the test says to close it.
    let (to_test, from_window) = tokio::sync::mpsc::unbounded_channel();
    let (close, closed) = mpsc::channel::<()>();
    let window = {
        let shared = shared.clone();
        tokio::task::spawn_blocking(move || {
            window::while_open(connection, || {
                let state = wait_for(&shared, "code", |s| {
                    matches!(s.status(), Status::Waiting { .. })
                });
                to_test.send(state).unwrap();
                wait_for(&shared, "connection", |s| s.status() == &Status::Connected);
                to_test.send(shared.snapshot()).unwrap();
                closed.recv().unwrap();
                Ok(())
            })
        })
    };
    let mut from_window = from_window;

    // Open: it asks for approval, the Stage approves, it is connected.
    from_window.recv().await.unwrap();
    let listed: MicBridges = app.get_json("/api/mic-bridges").await;
    stage
        .send(&ClientMessage::ApproveBridge {
            request_id: listed.requests[0].request_id,
        })
        .await;
    from_window.recv().await.unwrap();
    let listed: MicBridges = app.get_json("/api/mic-bridges").await;
    assert!(
        listed.bridges[0].open,
        "open while the window is: {listed:?}"
    );

    // Closed: the connection goes with it, and the Stage shows it closed.
    close.send(()).unwrap();
    window.await.unwrap().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let listed: MicBridges = app.get_json("/api/mic-bridges").await;
        if !listed.bridges[0].open {
            break;
        }
        assert!(Instant::now() < deadline, "still open: {listed:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[test]
fn the_binary_links_no_graphics_library() {
    let output = std::process::Command::new("readelf")
        .args(["--dynamic", env!("CARGO_BIN_EXE_openstar-mic-bridge")])
        .output()
        .expect("readelf (binutils) runs");
    assert!(output.status.success());
    let dynamic = String::from_utf8(output.stdout).unwrap();
    let needed: Vec<&str> = dynamic
        .lines()
        .filter(|line| line.contains("(NEEDED)"))
        .collect();
    assert!(!needed.is_empty(), "a dynamic binary: {dynamic}");
    for library in [
        "libGL",
        "libEGL",
        "libOpenGL",
        "libGLX",
        "libX11",
        "libxcb",
        "libwayland",
        "libxkbcommon",
        "libvulkan",
    ] {
        assert!(
            needed.iter().all(|line| !line.contains(library)),
            "{library} is linked: {needed:#?}"
        );
    }
}
