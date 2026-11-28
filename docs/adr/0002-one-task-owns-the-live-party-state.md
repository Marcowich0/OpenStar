# One task owns the live Party state

Accepted, 2026-11-27 (OpenStar v1, `b49c96f`). Recorded in [v1 spec: Architecture and deployment](https://github.com/Marcowich0/OpenStar/issues/44), "Language and stack".

The live Party state (the Party, its Party members, the Line-up, the Queue and the Stage) is owned by one tokio task. WebSocket and HTTP handlers hold a `LiveHandle`, send it `Command`s over an `mpsc` channel and await replies; none of them holds a lock on live state. The spec's reason is that connection handlers then never share locks: this was named as a house pattern so that agents follow one style for async code and shared state, which was one of the accepted costs of Rust ([ADR 0001](0001-rust-for-the-server-and-detector.md)).

## Consequences

- A new live feature is a new `Command` and a new arm in the task, not a new `Mutex` or `RwLock` around shared state.
- After every accepted change every connection is sent the whole Party plus a change event; a refused command gets a refusal code back (`ServerMessage::Rejected` with a `UserMessage`) and changes nothing.
- The same task is the Pitch reading relay: readings and clock pings go to the active Stage alone, unchanged. The relay never scores and never touches SQLite.
- State is keyed by a Stage id. v1 creates one, `MAIN_STAGE`, so more than one Stage per server stays possible.
- Database work still goes through `Database::call` on blocking threads (`crates/server/src/live/store.rs` persists the live state so it survives a restart).

## Where it shows up

- `crates/server/src/live/mod.rs` (module docs, `LiveHandle`, `Command`, the task's `run` loop) and the rest of `crates/server/src/live/`.
- `crates/server/tests/live_state.rs`.
