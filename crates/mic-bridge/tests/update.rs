//! The real `openstar-mic-bridge` binary updates itself to its server's
//! exact build (#209), against the real app in-process serving a copy of
//! the bridge under `/bridge/`.
//!
//! Every bridge here runs from a copy in a temporary folder, never from
//! Cargo's own binary, since an update replaces the file it runs from. "An
//! older build" is that copy with a test-build marker at its end (honoured
//! only by builds with debug assertions, see `SelfFile::build`), so the
//! test needs one compiled bridge, not two.

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use openstar_mic_bridge::update::TEST_BUILD_MARKER;
use openstar_protocol::bridge::{BridgeId, MicBridges, bridge_local_mic_id};
use openstar_protocol::library::{SongId, SongList};
use openstar_protocol::mics::{LocalMicSource, MicKey};
use openstar_protocol::profile::{Avatar, AvatarKey, PaletteKey};
use openstar_protocol::{
    ClientMessage, LineUpEdit, MicId, NewGuest, PartySnapshot, RequestId, SeatWho, ServerMessage,
    SongControl,
};
use openstar_test_harness::{TestApp, WsClient, fake_mic};
use tokio::io::{AsyncBufReadExt, BufReader, Lines};
use tokio::process::{Child, ChildStdout, Command};

const BRIDGE: &str = env!("CARGO_BIN_EXE_openstar-mic-bridge");
const WAIT: Duration = Duration::from_secs(20);
const DEVICE: &str = "multichannel.wav";
const OLD_BUILD: &str = "1.3.2";

/// A bridge installed in a temporary folder, with its own config folder.
struct Installed {
    dir: tempfile::TempDir,
    config: tempfile::TempDir,
}

impl Installed {
    /// A copy of the bridge this test was built with, pointed at `server`.
    fn new(server: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::copy(BRIDGE, dir.path().join("openstar-mic-bridge")).unwrap();
        let config = tempfile::tempdir().unwrap();
        let folder = config.path().join("openstar-mic-bridge");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("server"), format!("{server}\n")).unwrap();
        Self { dir, config }
    }

    fn binary(&self) -> PathBuf {
        self.dir.path().join("openstar-mic-bridge")
    }

    fn token(&self) -> String {
        std::fs::read_to_string(self.config.path().join("openstar-mic-bridge/token")).unwrap()
    }

    /// Turns the installed copy into another (older) build.
    fn make_old(&self) {
        let mut bytes = std::fs::read(self.binary()).unwrap();
        bytes.extend_from_slice(format!("{TEST_BUILD_MARKER}{OLD_BUILD}\n").as_bytes());
        std::fs::write(self.binary(), bytes).unwrap();
    }

    fn start(&self, wav: &Path) -> Bridge {
        let mut child = Command::new(self.binary())
            .arg("--wav")
            .arg(wav)
            .env_clear()
            .env("XDG_CONFIG_HOME", self.config.path())
            .env("HOME", "/nonexistent")
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        Bridge { child, lines }
    }
}

/// A running bridge and its stdout, line by line. Its process id stays the
/// same over a restart into a new build (an `exec`).
struct Bridge {
    child: Child,
    lines: Lines<BufReader<ChildStdout>>,
}

impl Bridge {
    /// Waits for a line starting with `prefix`, returns it whole, and
    /// fails on any line starting with one of `never`.
    async fn line_never(&mut self, prefix: &str, never: &[&str]) -> String {
        tokio::time::timeout(WAIT, async {
            loop {
                let line = self
                    .lines
                    .next_line()
                    .await
                    .unwrap()
                    .unwrap_or_else(|| panic!("the bridge ended before printing {prefix:?}"));
                if let Some(bad) = never.iter().find(|bad| line.starts_with(**bad)) {
                    panic!("the bridge printed {bad:?}: {line}");
                }
                if line.starts_with(prefix) {
                    return line;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("the bridge printed no {prefix:?} line in time"))
    }

    async fn line(&mut self, prefix: &str) -> String {
        self.line_never(prefix, &[]).await
    }

    async fn stop(mut self) {
        self.child.kill().await.unwrap();
        self.child.wait().await.unwrap();
    }
}

/// The app with one Song, serving a copy of this test's bridge as the
/// server's build.
async fn app_with_song_and_bridge(served: &Path) -> (TestApp, SongId) {
    std::fs::copy(BRIDGE, served.join("openstar-mic-bridge")).unwrap();
    let mut app = TestApp::builder().bridge_dir(served).start().await;
    let folder = app.songs_dir().join("Solo");
    std::fs::create_dir_all(&folder).unwrap();
    openstar_test_harness::placeholder_media(&folder.join("song.mp3")).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        "#ARTIST:Placeholder\n#TITLE:Solo\n#MP3:song.mp3\n#BPM:200\n: 0 4 0 La\nE\n",
    )
    .unwrap();
    app.restart().await;
    let songs = app.get_json::<SongList>("/api/songs").await.songs;
    (app, songs[0].id)
}

async fn next_party(stage: &mut WsClient) -> PartySnapshot {
    loop {
        if let ServerMessage::PartyChanged { party, .. } = stage.recv().await {
            return party;
        }
    }
}

/// Switches the bridge's channel 0 on, seats a Guest on it in a Request for
/// `song` and starts the Song.
async fn sing_on_channel_0(stage: &mut WsClient, bridge_id: &BridgeId, song: SongId) -> RequestId {
    let local_mic_id = bridge_local_mic_id(bridge_id, DEVICE, 0);
    stage
        .send(&ClientMessage::SetLocalMicSwitchedOn {
            local_mic_id: local_mic_id.clone(),
            source: LocalMicSource::Bridge {
                bridge_id: bridge_id.clone(),
                device_name: DEVICE.into(),
                label: DEVICE.into(),
                channel: 0,
            },
            switched_on: true,
        })
        .await;
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
    stage
        .send(&ClientMessage::EditLineUp {
            request_id,
            edit: LineUpEdit::AddSeat {
                who: SeatWho::Guest(NewGuest {
                    name: "Guest".into(),
                    colour: PaletteKey::ALL[0],
                    avatar: Avatar::BuiltIn {
                        key: AvatarKey::Star,
                    },
                }),
            },
        })
        .await;
    let mic = MicKey::LocalMic { local_mic_id };
    stage
        .send(&ClientMessage::EditLineUp {
            request_id,
            edit: LineUpEdit::SetMic {
                seat: 0,
                mic: mic.clone(),
            },
        })
        .await;
    loop {
        let party = next_party(stage).await;
        let seated = party.line_up.iter().any(|line_up| {
            line_up
                .seats
                .iter()
                .any(|seat| seat.mic == Some(mic.clone()))
        });
        if seated {
            break;
        }
    }
    stage
        .send(&ClientMessage::ControlSong {
            request_id,
            control: SongControl::Start,
        })
        .await;
    request_id
}

/// Plays the Stage (answers clock pings) until `wanted` holds for a
/// message, which it returns.
async fn play_until(
    stage: &mut WsClient,
    clock: Instant,
    what: &str,
    wanted: impl Fn(&ServerMessage) -> bool,
) -> ServerMessage {
    tokio::time::timeout(WAIT, async {
        loop {
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
                message if wanted(&message) => return message,
                _ => {}
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the Stage got no {what}"))
}

fn reading_of(mic: &MicId) -> impl Fn(&ServerMessage) -> bool + '_ {
    move |message| matches!(message, ServerMessage::PitchReading { mic: from, .. } if from == mic)
}

#[tokio::test]
async fn a_bridge_of_another_build_updates_during_a_song_and_reconnects_approved() {
    let served = tempfile::tempdir().unwrap();
    let (app, song) = app_with_song_and_bridge(served.path()).await;
    let mic_dir = tempfile::tempdir().unwrap();
    let wav = fake_mic::write(mic_dir.path()).unwrap().multichannel;
    let installed = Installed::new(&app.base_url());
    let mut stage = app.connect_stage().await;
    let clock = Instant::now();

    // The same build: it waits for approval, is approved, and connects.
    let mut bridge = installed.start(&wav);
    bridge
        .line_never("Waiting for approval", &["Updating"])
        .await;
    let listed: MicBridges = app.get_json("/api/mic-bridges").await;
    stage
        .send(&ClientMessage::ApproveBridge {
            request_id: listed.requests[0].request_id,
        })
        .await;
    bridge.line("Connected").await;
    let token = installed.token();
    let listed: MicBridges = app.get_json("/api/mic-bridges").await;
    let bridge_id = listed.bridges[0].bridge_id.clone();
    let mic = MicId::Bridge {
        bridge_id: bridge_id.clone(),
        local_mic_id: bridge_local_mic_id(&bridge_id, DEVICE, 0),
    };

    // It sings in a Song.
    sing_on_channel_0(&mut stage, &bridge_id, song).await;
    bridge.line("Detecting 1 channel(s)").await;
    play_until(&mut stage, clock, "reading", reading_of(&mic)).await;

    // Mid-Song, the bridge restarts as another build: it updates to the
    // server's, restarts into it and reconnects with its kept token. The
    // Stage loses its Mic for that moment, and then it reattaches.
    bridge.stop().await;
    installed.make_old();
    let mut bridge = installed.start(&wav);
    let pid = bridge.child.id();
    assert_eq!(
        bridge.line("Updating to").await,
        format!("Updating to {}…", openstar::BUILD_ID)
    );
    bridge
        .line_never("Connected", &["Waiting for approval"])
        .await;
    assert_eq!(bridge.child.id(), pid, "restarted in place");
    bridge.line("Detecting 1 channel(s)").await;
    play_until(
        &mut stage,
        clock,
        "Mic closed",
        |message| matches!(message, ServerMessage::MicClosed { mic: closed } if closed == &mic),
    )
    .await;
    play_until(
        &mut stage,
        clock,
        "reading after the update",
        reading_of(&mic),
    )
    .await;

    // It now is the server's copy, executable, and nothing is left beside
    // it; the token is the one it had, and it is the same bridge.
    assert_eq!(
        std::fs::read(installed.binary()).unwrap(),
        std::fs::read(served.path().join("openstar-mic-bridge")).unwrap()
    );
    let mode = std::fs::metadata(installed.binary())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o111, 0o111);
    assert_eq!(std::fs::read_dir(installed.dir.path()).unwrap().count(), 1);
    assert_eq!(installed.token(), token);
    let listed: MicBridges = app.get_json("/api/mic-bridges").await;
    assert_eq!(listed.requests, vec![]);
    assert_eq!(listed.bridges.len(), 1);
    assert_eq!(listed.bridges[0].bridge_id, bridge_id);
    assert!(listed.bridges[0].open);
    bridge.stop().await;
}

#[tokio::test]
async fn a_bridge_that_cannot_write_its_file_does_not_connect_and_says_how_to_update() {
    let served = tempfile::tempdir().unwrap();
    std::fs::copy(BRIDGE, served.path().join("openstar-mic-bridge")).unwrap();
    let app = TestApp::builder().bridge_dir(served.path()).start().await;
    let mic_dir = tempfile::tempdir().unwrap();
    let wav = fake_mic::write(mic_dir.path()).unwrap().multichannel;
    let installed = Installed::new(&app.base_url());
    installed.make_old();
    let before = std::fs::read(installed.binary()).unwrap();
    let read_only = std::fs::Permissions::from_mode(0o555);
    std::fs::set_permissions(installed.dir.path(), read_only).unwrap();
    if std::fs::write(installed.dir.path().join("probe"), b"").is_ok() {
        // Root writes anyway: the rule is about an ordinary user.
        std::fs::set_permissions(installed.dir.path(), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        return;
    }

    let mut bridge = installed.start(&wav);
    let message = bridge.line_never("This Mic bridge is", &["Updating"]).await;
    let command = bridge.line("To update it").await;
    let status = tokio::time::timeout(WAIT, bridge.child.wait())
        .await
        .unwrap()
        .unwrap();
    std::fs::set_permissions(installed.dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(
        message,
        format!(
            "This Mic bridge is {OLD_BUILD}, the server is {}",
            openstar::BUILD_ID
        )
    );
    assert!(
        command.ends_with(&format!(
            "curl -fsSL {}/bridge/install.sh | sh",
            app.base_url()
        )),
        "{command}"
    );
    assert!(!status.success(), "it stops: {status:?}");
    assert_eq!(std::fs::read(installed.binary()).unwrap(), before);
    let listed: MicBridges = app.get_json("/api/mic-bridges").await;
    assert!(
        listed.requests.is_empty() && listed.bridges.is_empty(),
        "{listed:?}"
    );
}
