//! Watching what the sound server offers while the bridge runs (v1 spec
//! #51, "Interface profile"): the cards and sources are read again every
//! [`INTERVAL`], so the bridge notices a profile change by itself however
//! it was made (its own Switch to Pro Audio, pavucontrol, `pactl`), and an
//! interface plugged in or out.
//!
//! **Switch to Pro Audio** (the window's button, or the Stage's through the
//! server) is the only way the bridge changes a profile: [`Watch::switch`]
//! is called for a press and nothing else calls it. A refused switch marks
//! that interface's profile message `switch_refused`, so it says to set the
//! profile in the sound settings with the `pactl` line; the mark goes once
//! the interface is in Pro Audio or gone.
//!
//! [`Watch`] is the pure bookkeeping over a [`SoundServer`]; [`spawn`] runs
//! it on a thread of its own (the calls block), handing [`Seen`] to the
//! connection through a [`tokio::sync::watch`] channel.

use std::collections::HashSet;
use std::sync::mpsc;
use std::time::Duration;

use openstar_protocol::bridge::NotProAudio;

use crate::discovery::{Discovered, Found};

/// How often the sound server is read again.
pub const INTERVAL: Duration = Duration::from_secs(2);

/// The desktop's sound server, as the bridge uses it. Both calls block.
pub trait SoundServer: Send {
    /// What it offers now.
    fn discover(&mut self) -> anyhow::Result<Discovered>;
    /// Switches card `card_name` to Pro Audio; an error is a refusal.
    fn switch_to_pro_audio(&mut self, card_name: &str) -> anyhow::Result<()>;
}

/// The real one, over the PulseAudio protocol.
pub struct Pulse;

impl SoundServer for Pulse {
    fn discover(&mut self) -> anyhow::Result<Discovered> {
        crate::capture::interfaces()
    }

    fn switch_to_pro_audio(&mut self, card_name: &str) -> anyhow::Result<()> {
        crate::pulse::switch_to_pro_audio(card_name)
    }
}

/// What the bridge sees: the interfaces it reads and the profile messages.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Seen {
    pub found: Vec<Found>,
    pub not_pro_audio: Vec<NotProAudio>,
}

/// The bookkeeping: what was last seen and which switches were refused.
#[derive(Default)]
pub struct Watch {
    seen: Seen,
    /// The `device_name`s whose last switch was refused.
    refused: HashSet<String>,
    /// The last error reading the sound server, said once.
    problem: Option<String>,
}

impl Watch {
    pub fn new() -> Self {
        Self::default()
    }

    /// What is seen now.
    pub fn seen(&self) -> &Seen {
        &self.seen
    }

    /// Reads `server` again; `true` when what is seen changed. A server
    /// that cannot be read offers nothing.
    pub fn read(&mut self, server: &mut dyn SoundServer) -> bool {
        let discovered = match server.discover() {
            Ok(discovered) => {
                self.problem = None;
                discovered
            }
            Err(error) => {
                let problem = format!("{error:#}");
                if self.problem.as_ref() != Some(&problem) {
                    eprintln!("OpenStar Mic bridge: no audio interfaces: {problem}");
                    self.problem = Some(problem);
                }
                Discovered::default()
            }
        };
        self.refused.retain(|device| {
            discovered
                .not_pro_audio
                .iter()
                .any(|card| &card.device_name == device)
        });
        let not_pro_audio = discovered
            .not_pro_audio
            .into_iter()
            .map(|card| NotProAudio {
                switch_refused: self.refused.contains(&card.device_name),
                ..card
            })
            .collect();
        // A source's latency moves from read to read: the one first read
        // for a source stays, so only a real change is a change.
        let found = discovered
            .interfaces
            .into_iter()
            .map(|found| {
                let before = self.seen.found.iter().find(|old| {
                    Found {
                        latency_ms: old.latency_ms,
                        ..found.clone()
                    } == **old
                });
                match before {
                    Some(old) => old.clone(),
                    None => found,
                }
            })
            .collect();
        let seen = Seen {
            found,
            not_pro_audio,
        };
        let changed = seen != self.seen;
        self.seen = seen;
        changed
    }

    /// Switch to Pro Audio was pressed for `device_name`: tries it on
    /// `server`, then reads it again. `true` when what is seen changed (a
    /// refusal changes the message). An interface not in the profile
    /// message is left alone.
    pub fn switch(&mut self, server: &mut dyn SoundServer, device_name: &str) -> bool {
        let Some(card) = self
            .seen
            .not_pro_audio
            .iter()
            .find(|card| card.device_name == device_name)
        else {
            return false;
        };
        let card_name = card.card_name.clone();
        match server.switch_to_pro_audio(&card_name) {
            Ok(()) => {
                self.refused.remove(device_name);
            }
            Err(error) => {
                eprintln!("OpenStar Mic bridge: {error:#}");
                self.refused.insert(device_name.to_owned());
            }
        }
        self.read(server)
    }
}

/// Presses Switch to Pro Audio: cheap to clone, for the window and the
/// connection.
#[derive(Clone)]
pub struct Switcher(mpsc::Sender<String>);

impl Switcher {
    /// Asks for `device_name` to be switched to Pro Audio.
    pub fn switch_to_pro_audio(&self, device_name: &str) {
        // The watcher has stopped only when the bridge is closing.
        let _ = self.0.send(device_name.to_owned());
    }
}

/// A running watch: what is seen, updated as it changes, and the button.
pub struct Watcher {
    pub seen: tokio::sync::watch::Receiver<Seen>,
    pub switcher: Switcher,
}

/// Reads `server` now and then every `interval` on a thread of its own,
/// and switches when a [`Switcher`] asks. The thread ends once every
/// [`Switcher`] and the receiver are gone.
pub fn spawn(mut server: Box<dyn SoundServer>, interval: Duration) -> Watcher {
    let mut watch = Watch::new();
    watch.read(server.as_mut());
    let (seen_tx, seen) = tokio::sync::watch::channel(watch.seen().clone());
    let (switch_tx, presses) = mpsc::channel::<String>();
    std::thread::Builder::new()
        .name("sound server watch".into())
        .spawn(move || {
            loop {
                let changed = match presses.recv_timeout(interval) {
                    Ok(device_name) => watch.switch(server.as_mut(), &device_name),
                    Err(mpsc::RecvTimeoutError::Timeout) => watch.read(server.as_mut()),
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                };
                if changed && seen_tx.send(watch.seen().clone()).is_err() {
                    return;
                }
            }
        })
        .expect("starting the sound server watch");
    Watcher {
        seen,
        switcher: Switcher(switch_tx),
    }
}

/// The interfaces the sound server offers, as a [`crate::client::Offer`]:
/// each captured with PipeWire, the list replaced whenever the watch sees a
/// change, and the Stage's Switch to Pro Audio passed to the watch.
pub struct Offering(Watcher);

impl Offering {
    pub fn new(watcher: Watcher) -> Self {
        let Watcher { mut seen, switcher } = watcher;
        // The first call answers with what is seen now.
        seen.mark_changed();
        Self(Watcher { seen, switcher })
    }
}

impl crate::client::Offer for Offering {
    fn changed(&mut self) -> Option<crate::client::Offered> {
        if !self.0.seen.has_changed().unwrap_or(false) {
            return None;
        }
        let seen = self.0.seen.borrow_and_update().clone();
        Some(crate::client::Offered {
            inputs: seen
                .found
                .into_iter()
                .map(|found| {
                    Box::new(crate::capture::PipeWireInput::new(found))
                        as Box<dyn crate::client::Input>
                })
                .collect(),
            not_pro_audio: seen.not_pro_audio,
        })
    }

    fn switch_to_pro_audio(&mut self, device_name: &str) {
        self.0.switcher.switch_to_pro_audio(device_name);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use openstar_protocol::bridge::BridgeInterface;

    use super::*;

    const CARD: &str = "alsa_card.usb-Focusrite-00";

    /// A sound server whose one card is in `profile`; it switches it to
    /// Pro Audio when asked unless `refuses`, and counts the switches.
    #[derive(Clone)]
    struct Fake(Arc<Mutex<FakeState>>);

    struct FakeState {
        pro_audio: bool,
        refuses: bool,
        switches: Vec<String>,
    }

    impl Fake {
        fn new(pro_audio: bool, refuses: bool) -> Self {
            Self(Arc::new(Mutex::new(FakeState {
                pro_audio,
                refuses,
                switches: Vec::new(),
            })))
        }

        fn set_pro_audio(&self, pro_audio: bool) {
            self.0.lock().unwrap().pro_audio = pro_audio;
        }

        fn switches(&self) -> Vec<String> {
            self.0.lock().unwrap().switches.clone()
        }
    }

    fn not_pro_audio(refused: bool) -> NotProAudio {
        NotProAudio {
            device_name: CARD.into(),
            card_name: format!("{CARD}-card"),
            label: "Scarlett 4i4".into(),
            profile: "Analog Surround 2.1".into(),
            switch_refused: refused,
        }
    }

    fn found() -> Found {
        Found {
            interface: BridgeInterface {
                device_name: CARD.into(),
                label: "Scarlett 4i4".into(),
                channels: 6,
                usb_id: Some("1235:821a".into()),
                twin: false,
            },
            node_name: "alsa_input.usb-Focusrite-00.pro-input-0".into(),
            sample_rate: 48_000,
            latency_ms: None,
        }
    }

    impl SoundServer for Fake {
        fn discover(&mut self) -> anyhow::Result<Discovered> {
            let state = self.0.lock().unwrap();
            Ok(if state.pro_audio {
                Discovered {
                    interfaces: vec![found()],
                    not_pro_audio: vec![],
                }
            } else {
                Discovered {
                    interfaces: vec![],
                    not_pro_audio: vec![not_pro_audio(false)],
                }
            })
        }

        fn switch_to_pro_audio(&mut self, card_name: &str) -> anyhow::Result<()> {
            let mut state = self.0.lock().unwrap();
            state.switches.push(card_name.to_owned());
            anyhow::ensure!(!state.refuses, "access denied");
            state.pro_audio = true;
            Ok(())
        }
    }

    #[test]
    fn an_interface_not_in_pro_audio_is_a_profile_message_and_no_channels() {
        let mut server = Fake::new(false, false);
        let mut watch = Watch::new();
        assert!(watch.read(&mut server));
        assert_eq!(
            watch.seen(),
            &Seen {
                found: vec![],
                not_pro_audio: vec![not_pro_audio(false)],
            }
        );
    }

    #[test]
    fn the_bridge_never_switches_a_profile_unless_the_button_is_pressed() {
        let mut server = Fake::new(false, false);
        let mut watch = Watch::new();
        for _ in 0..10 {
            watch.read(&mut server);
        }
        assert_eq!(server.switches(), Vec::<String>::new());
        assert_eq!(watch.seen().not_pro_audio.len(), 1);
    }

    #[test]
    fn switch_to_pro_audio_switches_the_card_by_its_server_name_and_its_channels_follow() {
        let mut server = Fake::new(false, false);
        let mut watch = Watch::new();
        watch.read(&mut server);
        assert!(watch.switch(&mut server, CARD));
        assert_eq!(server.switches(), vec![format!("{CARD}-card")]);
        assert_eq!(
            watch.seen(),
            &Seen {
                found: vec![found()],
                not_pro_audio: vec![],
            }
        );
    }

    #[test]
    fn a_refused_switch_marks_the_message_until_the_profile_is_pro_audio() {
        let mut server = Fake::new(false, true);
        let mut watch = Watch::new();
        watch.read(&mut server);
        assert!(watch.switch(&mut server, CARD));
        assert_eq!(watch.seen().not_pro_audio, vec![not_pro_audio(true)]);
        // Read again: still refused, nothing new.
        assert!(!watch.read(&mut server));
        assert_eq!(watch.seen().not_pro_audio, vec![not_pro_audio(true)]);

        // Set by hand in the sound settings: noticed by itself.
        server.set_pro_audio(true);
        assert!(watch.read(&mut server));
        assert_eq!(watch.seen().found, vec![found()]);
        // Switched away again later: a fresh message, not refused.
        server.set_pro_audio(false);
        watch.read(&mut server);
        assert_eq!(watch.seen().not_pro_audio, vec![not_pro_audio(false)]);
    }

    #[test]
    fn a_profile_changed_elsewhere_is_noticed_by_itself() {
        let mut server = Fake::new(false, false);
        let mut watch = Watch::new();
        watch.read(&mut server);
        assert!(!watch.read(&mut server));
        server.set_pro_audio(true);
        assert!(watch.read(&mut server));
        assert_eq!(watch.seen().found, vec![found()]);
        assert_eq!(server.switches(), Vec::<String>::new());
    }

    /// Reports a latency that moves with every read, as a real source's does.
    struct Jittery(f64);

    impl SoundServer for Jittery {
        fn discover(&mut self) -> anyhow::Result<Discovered> {
            self.0 += 0.25;
            Ok(Discovered {
                interfaces: vec![Found {
                    latency_ms: Some(self.0),
                    ..found()
                }],
                not_pro_audio: vec![],
            })
        }

        fn switch_to_pro_audio(&mut self, _card_name: &str) -> anyhow::Result<()> {
            unreachable!()
        }
    }

    #[test]
    fn a_moving_latency_is_no_change_and_the_first_one_read_is_kept() {
        let mut server = Jittery(8.0);
        let mut watch = Watch::new();
        assert!(watch.read(&mut server));
        for _ in 0..5 {
            assert!(!watch.read(&mut server));
        }
        assert_eq!(watch.seen().found[0].latency_ms, Some(8.25));
    }

    #[test]
    fn a_press_for_an_interface_without_a_message_does_nothing() {
        let mut server = Fake::new(true, false);
        let mut watch = Watch::new();
        watch.read(&mut server);
        assert!(!watch.switch(&mut server, CARD));
        assert!(!watch.switch(&mut server, "another card"));
        assert_eq!(server.switches(), Vec::<String>::new());
    }

    #[test]
    fn the_thread_notices_a_change_and_switches_when_pressed() {
        let server = Fake::new(false, true);
        let mut watcher = spawn(Box::new(server.clone()), Duration::from_millis(20));
        assert_eq!(
            watcher.seen.borrow().not_pro_audio,
            vec![not_pro_audio(false)]
        );

        watcher.switcher.switch_to_pro_audio(CARD);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(5), watcher.seen.changed())
                .await
                .unwrap()
                .unwrap();
        });
        assert_eq!(
            watcher.seen.borrow().not_pro_audio,
            vec![not_pro_audio(true)]
        );

        server.set_pro_audio(true);
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(5), watcher.seen.changed())
                .await
                .unwrap()
                .unwrap();
        });
        assert_eq!(watcher.seen.borrow().found, vec![found()]);
        assert_eq!(server.switches(), vec![format!("{CARD}-card")]);
    }
}
