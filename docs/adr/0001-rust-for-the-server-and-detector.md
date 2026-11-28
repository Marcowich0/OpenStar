# Rust for the server and the pitch detector

Accepted, 2026-11-27 (OpenStar v1, `b49c96f`). Decided in [Backend language and stack](https://github.com/Marcowich0/OpenStar/issues/11#issuecomment-7130122147); recorded in [v1 spec: Architecture and deployment](https://github.com/Marcowich0/OpenStar/issues/44), "Further Notes".

The owner's first requirement was that the language "be chosen based on performance". Published benchmarks put Rust ahead or level on every measure (worst-case delay, memory, CPU work), with Go close behind; on one room's load no difference between the two was expected to show. The near-tie was settled by who writes the code: with no human reviewing line by line, Rust's compiler is the strongest check (no data races, no null, errors must be handled, `match` must be exhaustive). So the server (tokio, axum, tower-http, rusqlite) and the one pitch detector are Rust, in one Cargo workspace with the Mic bridge, the protocol crate and the capture clock.

Rejected: Go (nearly equal, but more bugs reach runtime), Deno or TypeScript (one language with the frontend, but a lower performance tier), Bun (the same tier, and yt-dlp's Bun support is deprecated). There was no bake-off: scan time, relay delay and idle memory were never measured per runtime.

## Consequences

- Accepted costs: slower builds, more agent iterations on async code and shared state, and churn in crate APIs. They are handled by pinned versions and by the house patterns in `AGENTS.md` ([ADR 0002](0002-one-task-owns-the-live-party-state.md)).
- `unsafe_code = "forbid"` holds for the whole workspace; `crates/detector-wasm` alone sets its own lints, because its C ABI exports need `#[unsafe(no_mangle)]`.

## Where it shows up

- `Cargo.toml` (workspace members, `=` version pins, the workspace lints), `rust-toolchain.toml`.
- `crates/server`, `crates/detector`, `crates/detector-wasm/Cargo.toml` (the one lint exemption).
