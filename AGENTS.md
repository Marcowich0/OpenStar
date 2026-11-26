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
- `just check` before you push; CI runs `just ci`, which is `just check` and then `just e2e`. `just check` runs rustfmt, clippy, `cargo test`, `cargo deny`, ESLint, tsc and Vitest (`web-check`), the e2e suite's ESLint and tsc (`e2e-check`), Prettier, the generated-types drift check, the fixture guard, and the checks of CI's image tags (`ci-meta-check`), the version pins (`pins-check`), the Mic bridge install script (`shell-check`, needs ShellCheck), the bridge release tarball (`bridge-tarball-check`) and the compose examples (`compose-check`, needs Docker with the compose plugin, and jq); each is also a `just` recipe of its own. `just fmt` fixes formatting. `just e2e` builds the release binary, serves it with a temporary appdata and Library, and runs the Playwright suite in `e2e/` on Chromium from the pinned Playwright Docker image (needs Docker; arguments go to `playwright test`); on failure the report and traces are in `e2e/playwright-report/` and `e2e/test-results/`. It also compares the painter screenshots (`e2e/tests/painter.spec.ts`, from the test-only page `web/sing-test.html`) with the committed baselines in `e2e/tests/__screenshots__/`; `just update-screenshots` is the only command that writes those, so commit the changed images and look at them. There is no git pre-commit hook, and none is to be added. `just types` regenerates the TypeScript types, `just run` serves the app on port 8080.
- Versions are pinned: the Rust toolchain in `rust-toolchain.toml`, crates with `=` in the root `Cargo.toml`, npm packages exactly in `web/package.json`, pnpm in its `packageManager` field, Node in `.node-version`.

## House patterns

- **One owner for live state.** One task owns the live Party state (Party, Party members, Line-up, Queue, Stage) and takes commands on a channel (`crates/server/src/live/`). Connection handlers send it commands and receive replies or events; they never hold a lock on shared state.
- **Database calls on blocking threads.** Use `Database::call`, which runs the closure on a blocking thread. Never touch a `rusqlite::Connection` from async code.
- **Codes, not English.** The server sends codes plus parameters as the generated `UserMessage` (for example `ServerMessage::Rejected { reason }`); the frontend turns them into text. Logs are the only English the server writes.
- **Types are defined in Rust.** Every HTTP body and WebSocket message is a type in `crates/protocol` deriving `ts_rs::TS` with `#[ts(export)]`. WebSocket messages are enums tagged with `#[serde(tag = "type")]`, so the frontend `switch`es over them exhaustively. Never write these types by hand in TypeScript.
- **One guard rule.** The Admin PIN guards whatever changes the Library's files, deletes kept data, or takes the Stage. Classify every new HTTP endpoint by this rule in `crates/server/src/endpoints.rs`, the only place routes are mounted. The WebSocket carries no guarded action. The complete v1 list of guarded and not-guarded actions is in `docs/agents/guard-rule.md`.
- **No unsafe code.** `unsafe_code = "forbid"` holds for the whole workspace; the one planned exception is the `detector-wasm` crate.
