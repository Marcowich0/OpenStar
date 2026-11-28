# OpenStar

🎤 OpenStar is an open-source, self-hosted, SingStar-style karaoke game for your home server. Uses your existing UltraStar song library, runs in any browser, and turns phones into microphones and remotes. Real-time pitch scoring, duets, profiles and leaderboards. No installs needed.

## How it plays

OpenStar is played in one room. One browser, usually on the TV, is the **Stage**: it shows the Song, the lyrics and every Player's Notes, and it scores them. Guests join the current **Party** on their **Phones** with the join QR code or the Join code, and each Phone is a Remote (browse the Library, change the Queue, control the Stage) and, while it is in the Line-up, a microphone. Microphones wired to a computer in the room are **Local mics**, read by the Stage browser itself or by a **Mic bridge**, a small Linux desktop app.

Songs come from your UltraStar **Library** folder, which stays usable by other UltraStar programs. From the Admin area, behind the Admin PIN, the owner can Download Songs from USDB and fix a Song's timing with a Timing edit or Auto-fit.

## How it is built

- **Server** (`crates/server`, the `openstar` binary, Rust): one process in one Docker container. It serves the built frontend, an HTTP+JSON API, one WebSocket per browser and the Song media on one origin, keeps its state in SQLite, and runs ffprobe, ffmpeg and yt-dlp as child processes. It never hears Mic audio and never scores; it relays Pitch readings to the Stage and keeps the results.
- **Pitch detection** runs on the device that captures the sound, with one Rust detector (`crates/detector`): as WASM in an `AudioWorklet` on Phones and in the Stage browser (`crates/detector-wasm`), and natively in the Mic bridge (`crates/mic-bridge`). `crates/capture-clock` stamps every Pitch reading on the Stage's clock.
- **Protocol** (`crates/protocol`): every HTTP body and WebSocket message as Rust types; the frontend's TypeScript types are generated from them.
- **Frontend** (`web/`): one Vite + React app for the Stage, the Phones and the Admin area.
- **Tests**: `crates/test-harness` (the app in-process, a fake USDB, a yt-dlp stand-in), `e2e/` (Playwright) and `fixtures/` (test cases as data files).

Contributors and coding agents start with [`AGENTS.md`](AGENTS.md) (layout, commands and house patterns), [`GLOSSARY.md`](GLOSSARY.md) (the words the code and the docs use) and the decisions in [`docs/adr/`](docs/adr/).

## Installing

OpenStar runs as one Docker image, `ghcr.io/marcowich0/openstar`, on a trusted local network. Start from [`compose.yaml`](compose.yaml), or [`compose.caddy.yaml`](compose.caddy.yaml) for the HTTPS that Phones need. [Running OpenStar](docs/deployment.md) explains every setting, the volumes, Unraid, HTTPS, upgrades and backups.

## Releases

Before each `vX.Y.Z` tag, the [release checklist](docs/release-checklist.md) is worked through by hand. `:edge` builds from `main` need none.
