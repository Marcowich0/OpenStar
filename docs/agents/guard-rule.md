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

Becoming the Stage is not an Unlock, and an Unlock does not make a browser the Stage. It needs Stage trust instead: `POST /api/stage/trust` checks the Admin PIN itself, through the same PIN check and wrong-guess wait as the Unlock, and remembers the browser by its own cookie. `GET /ws/stage`, which makes a browser the Stage, refuses one without Stage trust (`403 stagePinRequired`). Both are classified `NotGuarded` in `endpoints.rs`, because the guard there checks an Unlock, which these must not need. Their handlers do the check instead.

Deleting a Profile is `DELETE /api/profiles/{id}`, classified `Guarded(Library::Untouched)`: it deletes kept data (the Profile and its Score records) and writes no Library file. The press and hold is the Admin area's; the server needs only the Unlock.

A Phone's Fit to the singing starts with `POST /api/songs/{id}/auto-fit`, classified `Guarded(Library::Writes)`: it is the Pitch track request behind the guard, refused at once while the Library is read-only because its Accept writes the Library. Accept is the guarded save `POST /api/songs/{id}/timing` with `autoFitFrom` (the Phone's id): it may change only `#GAP` and `#BPM`, and the Stage shows one `autoFitAccepted` toast for it. The desktop editor's own `POST /api/songs/{id}/pitch-track` stays not guarded.

`POST /api/unlock/heartbeat` is also classified guarded (`Library::Untouched`). It does nothing but needs a live Unlock, and it resets the idle time like a guarded action.

## Not guarded (no PIN, whatever the browser)

- opening the Admin area and looking at any section;
- Rescan and the Library problems list;
- browsing and searching USDB (`GET /api/usdb/songs`, on the mirror alone), its covers (`GET /api/usdb/songs/{id}/cover`: a cover is fetched once into `/appdata/cache`, which is neither the Library nor kept data), and seeing the video candidates (`GET /api/usdb/songs/{id}/videos`, `GET /api/usdb/video-details`: they read USDB and run yt-dlp lookups, writing nothing);
- the USDB login status (`GET /api/usdb/status`);
- the USDB mirror's status, the update the Downloads section asks for when it opens, and a full USDB refetch started by hand (`GET /api/usdb/mirror`, `POST /api/usdb/mirror/refresh`, `POST /api/usdb/mirror/refetch`): the mirror is a copy of USDB's list, not kept data, so dropping songs USDB no longer has deletes nothing kept;
- cancelling a Download;
- opening the desktop Timing editor on a Song, computing its Pitch track (`POST /api/songs/{id}/pitch-track`, from a Phone too) and downloading it (`GET /api/songs/{id}/pitch-track`), and working in the editor up to saving;
- the Timing edit preview (`POST /api/songs/{id}/timing/preview`), which writes nothing; saving it (`POST /api/songs/{id}/timing`) and Restore Original (`POST /api/songs/{id}/restore-original`) are guarded and write the Library;
- which Songs have an Original to restore (`GET /api/library/originals`);
- Undo of a Phone's fit proposal, which writes nothing;
- creating and editing Profiles;
- checking a Join code and joining the Party (Join code plus identity), and a Phone's silent rejoin with its Phone id;
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
- the job list (`GET /api/jobs`) and the job updates on the WebSocket;
- storing a round's outcome and its Score records (`POST /api/rounds`), which adds kept data and deletes none.

The test-only routes `POST /api/test/jobs` and `POST /api/test/jobs/{id}/cancel` (mounted only by `Server::with_test_routes`) are not guarded: a test job runs a harmless child process and touches nothing kept. The test-only route `POST /api/test/songs/{id}/pitch-track?timeoutMs=` is the Pitch track request with a short timeout, so it is not guarded either. The test-only route `POST /api/test/library/new-song` publishes a new Song folder the way a Download does, so it is `Guarded(Library::Writes)`.

Source: the "What the Admin PIN guards" section of the area spec #45, decided in #34 and #37.
