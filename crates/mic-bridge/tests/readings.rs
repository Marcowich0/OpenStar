//! Pitch readings from the real `openstar-mic-bridge` binary, headless with
//! `--wav` on the generated multichannel WAV (the tone on channel 0, silence
//! on the others), against the real app in-process, with this test as the
//! Stage answering its clock pings. Before approval the Stage gets no Pitch
//! readings; once the tone channel and a silent one are seated in a Song
//! that plays, readings reach the Stage under their Local mics, with the
//! tone's pitch on the tone channel and nothing voiced on the silent one.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use openstar_protocol::bridge::{BridgeId, MicBridges, bridge_local_mic_id};
use openstar_protocol::library::{SongId, SongList};
use openstar_protocol::mics::{LocalMicSource, MicKey};
use openstar_protocol::profile::{Avatar, AvatarKey, PaletteKey};
use openstar_protocol::{
    ClientMessage, LineUpEdit, MicId, NewGuest, PartySnapshot, PitchReading, RequestId, SeatWho,
    ServerMessage, SongControl,
};
use openstar_test_harness::{TestApp, WsClient, fake_mic};
use tokio::io::{AsyncBufReadExt, BufReader, Lines};
use tokio::process::{Child, ChildStdout, Command};

const BRIDGE: &str = env!("CARGO_BIN_EXE_openstar-mic-bridge");
const WAIT: Duration = Duration::from_secs(10);
const DEVICE: &str = "multichannel.wav";
/// How many readings of each Local mic the test looks at.
const READINGS: usize = 40;

/// A running bridge and its stdout, line by line.
struct Bridge {
    _config: tempfile::TempDir,
    child: Child,
    lines: Lines<BufReader<ChildStdout>>,
}

impl Bridge {
    /// Starts the bridge on `wav` with `server` as its address.
    fn start(server: &str, wav: &Path) -> Self {
        let config = tempfile::tempdir().unwrap();
        let dir = config.path().join("openstar-mic-bridge");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("server"), format!("{server}\n")).unwrap();
        let mut child = Command::new(BRIDGE)
            .arg("--wav")
            .arg(wav)
            .env_clear()
            .env("XDG_CONFIG_HOME", config.path())
            .env("HOME", "/nonexistent")
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        Self {
            _config: config,
            child,
            lines,
        }
    }

    /// Waits for a line that starts with `prefix`.
    async fn line(&mut self, prefix: &str) {
        tokio::time::timeout(WAIT, async {
            loop {
                let line = self
                    .lines
                    .next_line()
                    .await
                    .unwrap()
                    .unwrap_or_else(|| panic!("the bridge ended before printing {prefix:?}"));
                if line.starts_with(prefix) {
                    return;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("the bridge printed no {prefix:?} line within 10 s"));
    }

    async fn stop(mut self) {
        self.child.kill().await.unwrap();
    }
}

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

/// The Party in the next Party change on `stage`.
async fn next_party(stage: &mut WsClient) -> PartySnapshot {
    loop {
        if let ServerMessage::PartyChanged { party, .. } = stage.recv().await {
            return party;
        }
    }
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

/// Switches the bridge's `channels` on and seats a Guest on each in a new
/// Request for `song`; returns the Request once every seat has its Mic.
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
    let wanted: Vec<Option<MicKey>> = channels
        .iter()
        .map(|&channel| {
            Some(MicKey::LocalMic {
                local_mic_id: local_mic(bridge_id, channel).0,
            })
        })
        .collect();
    for (seat, mic) in wanted.iter().enumerate() {
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
                    mic: mic.clone().unwrap(),
                },
            })
            .await;
    }
    loop {
        let party = next_party(stage).await;
        let seated: Vec<Option<MicKey>> = party
            .line_up
            .iter()
            .flat_map(|line_up| line_up.seats.iter().map(|seat| seat.mic.clone()))
            .collect();
        if seated == wanted {
            return request_id;
        }
    }
}

/// Plays the Stage: answers every clock ping at once on its own clock and
/// keeps every Pitch reading, until `done` holds or 10 s have passed.
async fn stage_readings(
    stage: &mut WsClient,
    clock: Instant,
    mut done: impl FnMut(&[(MicId, PitchReading)]) -> bool,
) -> Vec<(MicId, PitchReading)> {
    let mut readings = Vec::new();
    let _ = tokio::time::timeout(WAIT, async {
        while !done(&readings) {
            match stage.recv().await {
                ServerMessage::ClockPing { mic, t0 } => {
                    stage
                        .send(&ClientMessage::ClockPong {
                            mic,
                            t0,
                            ts: clock.elapsed().as_secs_f64() * 1000.0,
                            epoch: 1.7e12,
                        })
                        .await;
                }
                ServerMessage::PitchReading { mic, reading } => readings.push((mic, reading)),
                _ => {}
            }
        }
    })
    .await;
    readings
}

#[tokio::test]
async fn a_wav_bridge_sends_the_tone_channels_pitch_to_the_stage_once_approved_and_seated() {
    let (app, song) = app_with_song().await;
    let mic_dir = tempfile::tempdir().unwrap();
    let wav = fake_mic::write(mic_dir.path()).unwrap().multichannel;
    let mut stage = app.connect_stage().await;
    let clock = Instant::now();
    assert!(matches!(
        stage.recv().await,
        ServerMessage::LiveState { is_stage: true, .. }
    ));
    let mut bridge = Bridge::start(&app.base_url(), &wav);
    bridge
        .line("Waiting for approval on the Stage: code ")
        .await;

    // Waiting for approval: no reading or ping reaches the Stage.
    tokio::time::sleep(Duration::from_millis(500)).await;
    stage.send(&ClientMessage::Ping { nonce: 3 }).await;
    loop {
        match stage.recv().await {
            ServerMessage::Pong { nonce: 3 } => break,
            message @ (ServerMessage::PitchReading { .. } | ServerMessage::ClockPing { .. }) => {
                panic!("before approval: {message:?}")
            }
            _ => {}
        }
    }

    let listed: MicBridges = app.get_json("/api/mic-bridges").await;
    stage
        .send(&ClientMessage::ApproveBridge {
            request_id: listed.requests[0].request_id,
        })
        .await;
    bridge.line("Connected").await;
    let listed: MicBridges = app.get_json("/api/mic-bridges").await;
    let bridge_id = listed.bridges[0].bridge_id.clone();

    // The tone channel and a silent one are seated, and the Song starts.
    let request = seat_bridge_mics(&mut stage, &bridge_id, song, &[0, 1]).await;
    stage
        .send(&ClientMessage::ControlSong {
            request_id: request,
            control: SongControl::Start,
        })
        .await;
    bridge.line("Detecting 2 channel(s)").await;

    let mic = |channel| MicId::Bridge {
        bridge_id: bridge_id.clone(),
        local_mic_id: bridge_local_mic_id(&bridge_id, DEVICE, channel),
    };
    let (tone, silent) = (mic(0), mic(1));
    let readings = stage_readings(&mut stage, clock, |readings| {
        [&tone, &silent]
            .iter()
            .all(|m| readings.iter().filter(|(r, _)| r == *m).count() >= READINGS)
    })
    .await;
    let of = |m: &MicId| -> Vec<PitchReading> {
        readings
            .iter()
            .filter(|(r, _)| r == m)
            .map(|(_, reading)| *reading)
            .collect()
    };
    let (tone_readings, silent_readings) = (of(&tone), of(&silent));
    assert!(
        tone_readings.len() >= READINGS && silent_readings.len() >= READINGS,
        "{} tone and {} silent readings in 10 s",
        tone_readings.len(),
        silent_readings.len()
    );
    assert!(
        readings.iter().all(|(m, _)| m == &tone || m == &silent),
        "only the seated channels detect"
    );
    // The fake mic's tone is A4 (440 Hz = MIDI 69).
    assert!(
        tone_readings
            .iter()
            .all(|r| r.pitch.is_some_and(|p| (p - 69.0).abs() < 0.1)),
        "{tone_readings:?}"
    );
    assert!(
        silent_readings.iter().all(|r| r.pitch.is_none()),
        "{silent_readings:?}"
    );
    // Stamped on the Stage's clock: within the last few seconds of it.
    let now = clock.elapsed().as_secs_f64() * 1000.0;
    assert!(
        tone_readings
            .iter()
            .all(|r| r.capture_ms <= now && r.capture_ms > now - 5_000.0),
        "now {now}: {tone_readings:?}"
    );
    bridge.stop().await;
}
