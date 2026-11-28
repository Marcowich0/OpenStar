# One guard rule for the Admin PIN

Accepted, 2026-11-27 (OpenStar v1, `b49c96f`). Recorded in [v1 spec: Admin area and Admin PIN](https://github.com/Marcowich0/OpenStar/issues/45).

Every Remote may change the Queue, the Line-up and playback, but a guest or a prankster on the guest network must not change the Library's files, delete data that took evenings to build up, or take over the Stage. So one rule classifies every action: **the Admin PIN guards whatever changes the Library's files, deletes kept data, or takes the Stage**, and nothing else. The spec's reason for one rule: a guard list that grows ticket by ticket drifts, while the rule classifies every new action the same way.

## Consequences

- Every HTTP endpoint is mounted in `crates/server/src/endpoints.rs` with its `Access`, and the guard comes from that classification, not from the handler. The server alone decides; the client never does.
- Every guarded action is an HTTP request. The WebSocket carries no guarded action: `ws_access` classifies every `ClientMessage` as `NotGuarded`.
- An Unlock and being the Stage are separate, because anyone in the room can reach the Stage computer's keyboard.
- The PIN guards against pranks and mistakes on a trusted local network, not against a determined attacker.

The full list of guarded actions, how the server applies the rule and the tests that pin it are in [`docs/agents/guard-rule.md`](../agents/guard-rule.md).

## Where it shows up

- `crates/server/src/endpoints.rs`, `crates/server/tests/guard.rs`, `web/src/guardAudit.test.ts`, `web/src/guarded/`.
