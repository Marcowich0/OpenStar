# OpenStar

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for Marcowich0/OpenStar, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Layout and commands

- `web/`: the Vite + React app; `web/src/generated/` holds the TypeScript types generated from `crates/protocol` (committed, never edited by hand). Where each crate and `web/src/` folder fits is under **Where things live** below.
- Integration tests: in `crates/server` and `crates/test-harness`, every file in `tests/` is a module of one test binary, `tests/main.rs` (`autotests = false`), since a binary per file links the whole crate again and fills the disk. A new test file needs its `mod` line there; `every_test_file_is_a_module` fails until it has one. Run one file's tests with `cargo test -p <crate> --test integration <file>::`.
- `fixtures/`: test cases as data files, shared by every implementation. Read `fixtures/README.md` before you add one: placeholder lyrics only, no real Song audio, openly licensed media only beside an `ATTRIBUTION.md`, floors only ever rise.
- While you work, `just quick` (`scripts/quick-check.sh`) runs only the checks the files changed since `origin/main` can affect: rustfmt, workspace clippy, the tests of the changed crates and every crate that depends on them, the drift check if `crates/protocol` changed, ESLint on the changed web files, tsc, `vitest related` (all of Vitest if the detector or capture clock changed), the e2e lint, the fixture guard, and Prettier on the changed files. It names what it leaves to `just check`. Narrower still: one Rust test file with `cargo test -p <crate> --test integration <file>::`, one crate's unit tests with `cargo test -p <crate> --lib`, one web area with `pnpm --dir web exec vitest run src/<area>`.
- `just check` before you push; CI runs `just ci`, which is `just check` and then `just e2e`, as parallel jobs: `just check-rust`, `just check-rest` (the two halves of `check`; a new check goes in one of them) and `just e2e` in three shards. `just check` runs rustfmt, clippy, `cargo test`, `cargo deny`, ESLint, tsc and Vitest (`web-check`), the e2e suite's ESLint and tsc (`e2e-check`), Prettier, the generated-types drift check, the fixture guard, and the checks of CI's image tags (`ci-meta-check`), the version pins (`pins-check`), the Mic bridge install script (`shell-check`, needs ShellCheck), the bridge release tarball (`bridge-tarball-check`) and the compose examples (`compose-check`, needs Docker with the compose plugin, and jq); each is also a `just` recipe of its own. `just fmt` fixes formatting. `just e2e` builds the release binary, serves it with a temporary appdata and Library, and runs the Playwright suite in `e2e/` on Chromium from the pinned Playwright Docker image (needs Docker; arguments go to `playwright test`); on failure the report and traces are in `e2e/playwright-report/` and `e2e/test-results/`. It also compares the painter screenshots (`e2e/tests/painter.spec.ts`, from the test-only page `web/sing-test.html`) with the committed baselines in `e2e/tests/__screenshots__/`; `just update-screenshots` is the only command that writes those, so commit the changed images and look at them. There is no git pre-commit hook, and none is to be added. `just types` regenerates the TypeScript types, `just run` serves the app on port 8080.
- Vitest runs `*.test.tsx` and the `.test.ts` files listed in `DOM_TESTS` (`web/vite.config.ts`) in jsdom, and every other `.test.ts` in plain node. A new `.test.ts` that needs a DOM fails with "document is not defined": add it to `DOM_TESTS`.
- Dev and test builds carry line tables only (`[profile.dev]` in the root `Cargo.toml`). For a debugger, pass `--config 'profile.dev.debug=true'` to cargo rather than changing the profile.
- Versions are pinned: the Rust toolchain in `rust-toolchain.toml`, crates with `=` in the root `Cargo.toml`, npm packages exactly in `web/package.json`, pnpm in its `packageManager` field, Node in `.node-version`.

## House patterns

- **One owner for live state.** One task owns the live Party state (Party, Party members, Line-up, Queue, Stage) and takes commands on a channel (`crates/server/src/live/`). Connection handlers send it commands and receive replies or events; they never hold a lock on shared state.
- **Database calls on blocking threads.** Use `Database::call`, which runs the closure on a blocking thread. Never touch a `rusqlite::Connection` from async code.
- **Codes, not English.** The server sends codes plus parameters as the generated `UserMessage` (for example `ServerMessage::Rejected { reason }`); the frontend turns them into text. Logs are the only English the server writes.
- **Types are defined in Rust.** Every HTTP body and WebSocket message is a type in `crates/protocol` deriving `ts_rs::TS` with `#[ts(export)]`. WebSocket messages are enums tagged with `#[serde(tag = "type")]`, so the frontend `switch`es over them exhaustively. Never write these types by hand in TypeScript.
- **One guard rule.** The Admin PIN guards whatever changes the Library's files, deletes kept data, or takes the Stage. Classify every new HTTP endpoint by this rule in `crates/server/src/endpoints.rs`, the only place routes are mounted. The WebSocket carries no guarded action. The complete v1 list of guarded and not-guarded actions is in `docs/agents/guard-rule.md`.
- **No unsafe code.** `unsafe_code = "forbid"` holds for the whole workspace; the one planned exception is the `detector-wasm` crate.

## Where things live

Crates:

- `crates/server`: the `openstar` binary: HTTP+JSON API, WebSocket, the live Party task (`live/`), Library scan and writes, USDB Downloads, jobs, SQLite.
- `crates/protocol`: every HTTP body and WebSocket message as Rust types; the source of `web/src/generated/`.
- `crates/detector`: the one live pitch detector (MPM) that makes Pitch readings, and the YIN Pitch track detector.
- `crates/detector-wasm`: the detector and capture clock as a WASM module for the AudioWorklet (`just wasm`).
- `crates/capture-clock`: puts Pitch readings on the Stage's clock: frame mapping, clock sync, ping schedule.
- `crates/mic-bridge`: the Mic bridge desktop app: PipeWire capture, window, Pitch readings, self-update, install script.
- `crates/test-harness`: the app in-process, fake USDB, yt-dlp stub, ffmpeg media, fixture Library, bridge launcher.

`web/src/`:

- `stage/`: the Stage: frame, input, song browser, Line-up, sing screen and its painter, results, overlays, join card.
- `phone/`: the Phone: join flow, Remote tabs (Songs, Queue, Stage, People), mic and Calibrating takeovers.
- `admin/`: the Admin area: Songs, Downloads, Library problems, Profiles, trash, and the Timing editor (`timing/`).
- `live/`: the WebSocket client and live store: Party state, seats, the playing Song, toasts, Stage trust.
- `api/`: the one `fetch` wrapper, typed endpoints, TanStack queries, change notices that invalidate queries.
- `i18n/`: `t(key, params)`, the English catalogue `en.ts`, the text for server codes (`serverText.ts`).
- `pitch/`: capture pipeline, the AudioWorklet with the WASM detector, sender clock, per-Player reading buffers.
- `scoring/`: the scorer: Beat values, Line bonus and Line ratings, live scoring, Mic lost.
- `clock/`: the Song clock, Beats from `#GAP`/`#BPM`, placing Pitch readings on Song time.
- `playback/`: the Stage's media element, playback plan, gain chain, output time, Song previews, Skip intro.
- `calibration/`, `mics/`, `bridge/`: Calibration on the Stage; the Mics screen (Local mics, Mic bridges, Mic settings); the `/bridge` install page.
- `avOffset/`, `avSync/`: the A/V offset per sound output, and the Check A/V sync step.
- `timing/`, `fit/`, `editorAudio/`: Timing edits as `TimingOperation`s; Fit to the singing and Line suggestions; the Timing editor's playback.
- `guarded/`, `pin/`: the one guarded-action flow (Unlock, heartbeat, read-only notice) and the Admin PIN pad.
- `profile/`, `stageOptions/`, `toasts/`: the Profile page; Stage options (Setup › Options); toast timing and content.
- `ui/`, `theme/`, `icons/`, `avatars/`: shared components, design tokens, fonts and motion, SVG icons and avatars.
- `adminTest/`, `singTest/`, `test/`: the test-only Admin and painter-screenshot pages, and the Vitest setup.
