//! The Pro Audio profile message over the real connection (#206): the
//! bridge's client against the real server, with a fake sound server whose
//! one interface is in another profile until Switch to Pro Audio is pressed
//! on the Stage. No sound server or audio hardware is used: the interface
//! is the fake multichannel WAV, offered once "switched".

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openstar_mic_bridge::client::{self, Input, Offer, Offered};
use openstar_mic_bridge::config::ConfigDir;
use openstar_mic_bridge::wav;
use openstar_mic_bridge::window::Shared;
use openstar_mic_bridge::window::state::WindowState;
use openstar_protocol::ClientMessage;
use openstar_protocol::bridge::{MicBridges, NotProAudio, bridge_local_mic_id};
use openstar_test_harness::{TestApp, fake_mic};

const WAV: &str = "multichannel.wav";

fn in_hifi(switch_refused: bool) -> NotProAudio {
    NotProAudio {
        device_name: WAV.into(),
        card_name: WAV.into(),
        label: "UMC404HD 192k".into(),
        profile: "HiFi".into(),
        switch_refused,
    }
}

/// A sound server whose interface is in HiFi until switched (or refusing).
#[derive(Clone)]
struct FakeSoundServer(Arc<Mutex<Fake>>);

struct Fake {
    audio: wav::WavAudio,
    refuses: bool,
    switched: bool,
    switches: Vec<String>,
    /// Something changed since the bridge last asked.
    changed: bool,
}

impl Offer for FakeSoundServer {
    fn changed(&mut self) -> Option<Offered> {
        let mut fake = self.0.lock().unwrap();
        if !std::mem::take(&mut fake.changed) {
            return None;
        }
        Some(if fake.switched {
            Offered {
                inputs: vec![
                    Box::new(wav::WavInput::new(WAV.into(), fake.audio.clone())) as Box<dyn Input>
                ],
                not_pro_audio: vec![],
            }
        } else {
            Offered {
                inputs: vec![],
                not_pro_audio: vec![in_hifi(!fake.switches.is_empty() && fake.refuses)],
            }
        })
    }

    fn switch_to_pro_audio(&mut self, device_name: &str) {
        let mut fake = self.0.lock().unwrap();
        fake.switches.push(device_name.to_owned());
        fake.switched = !fake.refuses;
        fake.changed = true;
    }
}

async fn wait_for_listing(app: &TestApp, what: &str, check: impl Fn(&MicBridges) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let listing: MicBridges = app.get_json("/api/mic-bridges").await;
        if check(&listing) {
            return;
        }
        assert!(Instant::now() < deadline, "no {what}: {listing:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Starts the bridge against `app` with `fake`, approves it on `stage`;
/// returns what its window shows.
async fn approved_bridge(
    app: &TestApp,
    stage: &mut openstar_test_harness::WsClient,
    fake: FakeSoundServer,
    config_dir: &tempfile::TempDir,
) -> Shared {
    std::fs::write(config_dir.path().join("server"), app.base_url()).unwrap();
    let shared = Shared::new(WindowState::new(app.base_url(), vec![]));
    let config = ConfigDir::at(config_dir.path().to_owned());
    let mut report = shared.clone();
    tokio::spawn(async move {
        let ended = client::run_offered(config, Box::new(fake), &mut report).await;
        panic!("the same build never stops connecting: {ended:?}");
    });
    wait_for_listing(app, "request", |l| !l.requests.is_empty()).await;
    let listing: MicBridges = app.get_json("/api/mic-bridges").await;
    stage
        .send(&ClientMessage::ApproveBridge {
            request_id: listing.requests[0].request_id,
        })
        .await;
    wait_for_listing(app, "open bridge", |l| {
        l.bridges.first().is_some_and(|b| b.open)
    })
    .await;
    shared
}

fn fake(refuses: bool) -> FakeSoundServer {
    let mic = tempfile::tempdir().unwrap();
    let wav_file = fake_mic::write(mic.path()).unwrap().multichannel;
    let audio = wav::read_audio(std::io::BufReader::new(
        std::fs::File::open(wav_file).unwrap(),
    ))
    .unwrap();
    FakeSoundServer(Arc::new(Mutex::new(Fake {
        audio,
        refuses,
        switched: false,
        switches: Vec::new(),
        changed: true,
    })))
}

#[tokio::test(flavor = "multi_thread")]
async fn switch_to_pro_audio_on_the_stage_switches_and_the_channels_come_with_their_ids() {
    let app = TestApp::start().await;
    let mut stage = app.connect_stage().await;
    let fake = fake(false);
    let config_dir = tempfile::tempdir().unwrap();
    let shared = approved_bridge(&app, &mut stage, fake.clone(), &config_dir).await;

    // The message is on the Stage and in the window; nothing is read.
    wait_for_listing(&app, "profile message", |l| {
        l.bridges[0].not_pro_audio == vec![in_hifi(false)] && l.bridges[0].channels.is_empty()
    })
    .await;
    assert_eq!(shared.snapshot().not_pro_audio(), &[in_hifi(false)]);
    assert!(
        fake.0.lock().unwrap().switches.is_empty(),
        "never on its own"
    );

    let listing: MicBridges = app.get_json("/api/mic-bridges").await;
    let bridge_id = listing.bridges[0].bridge_id.clone();
    stage
        .send(&ClientMessage::SwitchBridgeToProAudio {
            bridge_id: bridge_id.clone(),
            device_name: WAV.into(),
        })
        .await;
    wait_for_listing(&app, "channels", |l| {
        l.bridges[0].not_pro_audio.is_empty() && l.bridges[0].channels.len() == 4
    })
    .await;
    assert_eq!(fake.0.lock().unwrap().switches, vec![WAV.to_owned()]);
    let listing: MicBridges = app.get_json("/api/mic-bridges").await;
    let ids: Vec<String> = listing.bridges[0]
        .channels
        .iter()
        .map(|c| c.local_mic_id.clone())
        .collect();
    assert_eq!(
        ids,
        (0..4)
            .map(|n| bridge_local_mic_id(&bridge_id, WAV, n))
            .collect::<Vec<_>>()
    );
    let state = shared.snapshot();
    assert_eq!(state.not_pro_audio(), &[]);
    assert_eq!(state.interfaces()[0].channels.len(), 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_switch_reaches_the_stage_and_the_window() {
    let app = TestApp::start().await;
    let mut stage = app.connect_stage().await;
    let fake = fake(true);
    let config_dir = tempfile::tempdir().unwrap();
    let shared = approved_bridge(&app, &mut stage, fake.clone(), &config_dir).await;
    let listing: MicBridges = app.get_json("/api/mic-bridges").await;
    stage
        .send(&ClientMessage::SwitchBridgeToProAudio {
            bridge_id: listing.bridges[0].bridge_id.clone(),
            device_name: WAV.into(),
        })
        .await;
    wait_for_listing(&app, "refusal", |l| {
        l.bridges[0].not_pro_audio == vec![in_hifi(true)]
    })
    .await;
    assert_eq!(shared.snapshot().not_pro_audio(), &[in_hifi(true)]);
}
