# Pitch is detected on the capturing device, and the Stage scores

Accepted, 2026-11-27 (OpenStar v1, `b49c96f`). Decided with the owner on 2026-11-24 in [Where pitch detection runs and how phones reach the stage](https://github.com/Marcowich0/OpenStar/issues/9); recorded in [v1 spec: Pitch readings and Phone mics](https://github.com/Marcowich0/OpenStar/issues/50), "Further Notes".

Each Mic's pitch is detected on the device that captures its sound: a Phone, the Stage browser (for its own Local mics) or a Mic bridge. All of them run one McLeod Pitch Method detector, written once in Rust: as WASM in an `AudioWorklet` in browsers, natively in the Mic bridge. Audio never leaves the device; only Pitch readings travel, each stamped with its capture time on the Stage's clock. The server relays them over the WebSocket to the Stage and stores final results. The Stage scores every Player with one scorer, whatever kind of Mic sent the readings, and a Phone knows nothing about the Song.

Recorded reasons: Pitch readings are tiny messages every target browser can send, and pitch-only is the one design found in open-source phone-mic karaoke games. Capture times on one clock keep network delay and jitter out of the Score, so Calibration only has to find fixed device delays. Keeping the Phone ignorant of the Song means it needs no song clock, and the thresholds and the scorer stay in one place. One Rust detector is one implementation pinned by one test suite.

## Rejected alternatives

- Stamping readings on arrival and folding the network into a calibration constant: jitter lands straight in the Score.
- Pushing Song time to the Phone and keying readings to Beats there: the Phone would need the song clock, and scoring would be split across devices.
- A WebRTC data channel to fix stutter: an A/B run on a Phone showed the Wi-Fi radio holds both transports alike.

## Consequences

- The server never processes Mic audio. Its only signal processing is offline analysis of a Song's own files (the scan's probe and loudness, and the Pitch track for an Auto-fit).
- A Phone needs HTTPS for its microphone, so HTTPS is part of deployment ([`docs/deployment.md`](../deployment.md)).

## Where it shows up

- `crates/detector` (crate docs), `crates/detector-wasm`, `crates/capture-clock`, `crates/mic-bridge`.
- `web/src/pitch/worklet/`, `web/src/pitch/capture/capturePipeline.ts`, `web/src/scoring/`, `web/src/clock/placement.ts`.
- `crates/server/src/live/mod.rs` (the relay).
