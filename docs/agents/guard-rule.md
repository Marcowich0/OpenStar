# The guard rule

Every new HTTP endpoint, in every area, is classified by this one rule.

**The Admin PIN guards whatever changes the Library's files, deletes kept data, or takes the Stage.** Everything else is not guarded, whatever the browser.

## How the server applies it

- Mount every endpoint in `crates/server/src/endpoints.rs` with its `Access`: `NotGuarded`, `Guarded(Library::Writes)` or `Guarded(Library::Untouched)`. The guard comes from that classification, not from the handler. A test fails if a router is built or a route is mounted anywhere else in `crates/server/src`.
- A guarded endpoint without a live Unlock is refused with `401 {"code":"unlockRequired"}`. With one, the call resets the Unlock's idle time.
- A guarded endpoint that writes the Library (the songs folder) is refused with `409 {"code":"libraryReadOnly"}` while the Library is read-only, whatever the Unlock. That check comes before the Unlock check.
- The client never decides. The frontend shows the PIN pad when it gets `unlockRequired` and the read-only notice when it gets `libraryReadOnly`.
- The WebSocket carries no guarded action. `endpoints::ws_access` classifies every `ClientMessage`, and every arm must be `Access::NotGuarded`. A guarded action is an HTTP endpoint instead. When you add a `ClientMessage` variant, add a sample to `every_client_message` in `crates/server/tests/guard.rs`.
- `crates/server/tests/guard.rs` walks every classified endpoint. Every guarded one must refuse without an Unlock and get past the guard with one. Every not-guarded one must answer without one. Every Library write must be refused while the Library is read-only. New endpoints join these tests automatically.

## Guarded actions (the complete v1 list)

| Action                                                                                                                  | Where                 | Needs                      | Writes the Library |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------- | ------------------ |
| Starting a Download (the PIN is asked when the Download starts, after the video pick)                                   | Admin area, Downloads | Unlock                     | yes                |
| Saving a Timing edit in the desktop Timing editor                                                                       | Admin area, Songs     | Unlock                     | yes                |
| Running "Fit to the singing" on a Phone, and accepting its proposal                                                     | Admin area, Songs     | Unlock                     | yes                |
| Restore Original                                                                                                        | Admin area, Songs     | Unlock                     | yes                |
| Deleting a Song (to the 30-day trash); refused while it plays                                                           | Admin area, Songs     | Unlock plus press and hold | yes                |
| Restoring a Song from the trash                                                                                         | Admin area, Songs     | Unlock plus press and hold | yes                |
| Deleting a Profile (and its Score records); refused while that Profile sings                                            | Admin area, Profiles  | Unlock plus press and hold | no                 |
| Forget a Mic bridge (removes its approval token and its Local mics, with their Mic delays and bleed levels)             | Stage, Mics screen    | Unlock plus press and hold | no                 |
| Becoming the Stage: the first Stage on a fresh server, taking over by opening `/stage`, and "Make this the Stage again" | `/stage`              | PIN once per browser       | no                 |

Becoming the Stage is not an Unlock, and an Unlock does not make a browser the Stage. Its PIN check belongs to its own ticket (Stage trust), which reuses the PIN check and the wrong-guess wait.

`POST /api/unlock/heartbeat` is also classified guarded (`Library::Untouched`). It does nothing but needs a live Unlock, and it resets the idle time like a guarded action.

## Not guarded (no PIN, whatever the browser)

- opening the Admin area and looking at any section;
- Rescan and the Library problems list;
- browsing and searching USDB, and seeing the video candidates;
- a full USDB refetch started by hand;
- cancelling a Download;
- opening the desktop Timing editor on a Song, computing its Pitch track, and working in the editor up to saving;
- Undo of a Phone's fit proposal, which writes nothing;
- creating and editing Profiles;
- removing a Party member (press and hold) and Leave party;
- New party (press and hold only);
- every Queue, Line-up and playback action, including Restart, Skip and End (press and hold);
- Calibrate mics and "Calibrate this mic now";
- Check A/V sync;
- setting the OpenStar volume, from the Stage or a Remote;
- hiding the join card;
- on the Mics screen: switching Local mics on and off, renaming a Local mic, Find it, and setting a Mic threshold;
- Add a Mic bridge, the `/bridge` page and its download;
- approving a new Mic bridge on the Stage's Mics screen (the Stage browser is already trusted through the PIN);
- Lock, the Unlock status and the PIN attempt itself;
- the job list (`GET /api/jobs`) and the job updates on the WebSocket.

The test-only routes `POST /api/test/jobs` and `POST /api/test/jobs/{id}/cancel` (mounted only by `Server::with_test_routes`) are not guarded: a test job runs a harmless child process and touches nothing kept.

Source: the "What the Admin PIN guards" section of the area spec #45, decided in #34 and #37.
