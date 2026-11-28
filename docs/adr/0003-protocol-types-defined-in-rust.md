# Protocol types are defined in Rust and generated for TypeScript

Accepted, 2026-11-27 (OpenStar v1, `b49c96f`). Recorded in [v1 spec: Architecture and deployment](https://github.com/Marcowich0/OpenStar/issues/44), "One source for message types".

The Rust types in `crates/protocol` are the single source of every HTTP body and WebSocket message. Each derives `ts_rs::TS` with `#[ts(export)]`, and the frontend's TypeScript types are generated from them into `web/src/generated/`, which is committed. The spec's reason is that the two sides can't disagree about a message. The generator is `ts-rs` (a derive on the Rust types), not `specta`.

## Consequences

- Never write or edit these types by hand in TypeScript. Change the Rust type and run `just types`.
- `just drift-check` (part of `just check`) regenerates the files and fails on any diff or untracked file, so CI fails when they are out of date.
- WebSocket messages are enums tagged with `#[serde(tag = "type")]`, so the frontend's reducer and code renderers `switch` over them exhaustively and `tsc` fails when a variant added in Rust is not handled.

## Where it shows up

- `crates/protocol/src/` (crate docs in `lib.rs`), `crates/protocol/tests/wire_format.rs`.
- `web/src/generated/`, `justfile` (`types`, `drift-check`).
- `web/src/api/api.ts` (every endpoint typed with the generated request and response types), `web/src/live/liveState.ts`.
