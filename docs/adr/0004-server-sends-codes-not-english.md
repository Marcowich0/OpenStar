# The server sends codes, the frontend owns every word

Accepted, 2026-11-27 (OpenStar v1, `b49c96f`). Recorded in [v1 spec: Architecture and deployment](https://github.com/Marcowich0/OpenStar/issues/44) ("No on-screen English from Rust") and [v1 spec: Frontend architecture and rendering](https://github.com/Marcowich0/OpenStar/issues/56) ("Interface strings").

The server never sends on-screen English. Refusals, Library problem reasons, job errors, USDB login failures and toast events travel as codes plus parameters (the generated `UserMessage` and similar code unions), and the frontend turns each into text with a typed `t(key, params)` over one English catalogue. The specs give two reasons: every word on screen comes from that catalogue, and translating OpenStar later means adding a catalogue, with no change where strings are used and no developer needed. Logs are the only English the server writes.

## Consequences

- A new server error or notice is a new code (with typed parameters) in `crates/protocol`, plus a catalogue string. `tsc` fails until the code has one, because each code union's renderer must name every code.
- A missing catalogue key, or a missing or wrongly typed parameter, is a type error.
- v1 uses no i18n library; this was a deliberate choice (listed among the rejected libraries in the frontend spec).

## Where it shows up

- `crates/protocol/src/lib.rs` (`UserMessage`, `ServerMessage::Rejected`).
- `web/src/i18n/` (`t.ts`, the catalogue `en.ts`, `serverText.ts`).
