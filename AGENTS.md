# OpenStar

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for Marcowich0/OpenStar, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Layout and commands

- `crates/server`: the `openstar` binary (tokio, axum, tower-http, rusqlite).
- `crates/protocol`: every HTTP body and WebSocket message, as Rust types.
- `web/`: the Vite + React app; `web/src/generated/` holds the TypeScript types generated from `crates/protocol` (committed, never edited by hand).
- `fixtures/`: test cases as data files, shared by every implementation. Read `fixtures/README.md` before you add one: placeholder lyrics only, no real Song audio, openly licensed media only beside an `ATTRIBUTION.md`, floors only ever rise.
- `just check` before you push; CI runs `just ci`. It runs rustfmt, clippy, `cargo test`, `cargo deny`, ESLint, tsc, Vitest, Prettier, the generated-types drift check and the fixture guard; `just fmt` fixes formatting. There is no git pre-commit hook, and none is to be added. `just types` regenerates the TypeScript types, `just run` serves the app on port 8080.
- Versions are pinned: the Rust toolchain in `rust-toolchain.toml`, crates with `=` in the root `Cargo.toml`, npm packages exactly in `web/package.json`, pnpm in its `packageManager` field, Node in `.node-version`.

## House patterns

- **One owner for live state.** One task owns the live Party state (Party, Party members, Line-up, Queue, Stage) and takes commands on a channel. Connection handlers send it commands and receive replies or events; they never hold a lock on shared state.
- **Database calls on blocking threads.** Use `Database::call`, which runs the closure on a blocking thread. Never touch a `rusqlite::Connection` from async code.
- **Codes, not English.** The server sends codes plus parameters (for example `ServerMessage::Rejected { code }`); the frontend turns them into text. Logs are the only English the server writes.
- **Types are defined in Rust.** Every HTTP body and WebSocket message is a type in `crates/protocol` deriving `ts_rs::TS` with `#[ts(export)]`. WebSocket messages are enums tagged with `#[serde(tag = "type")]`, so the frontend `switch`es over them exhaustively. Never write these types by hand in TypeScript.
- **No unsafe code.** `unsafe_code = "forbid"` holds for the whole workspace; the one planned exception is the `detector-wasm` crate.
