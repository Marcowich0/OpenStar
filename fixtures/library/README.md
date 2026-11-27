# The fixture Library

A few synthetic Songs with placeholder lyrics, shared by the server integration
tests and `just e2e`. Only the `.txt` files are committed. Each Song's audio is
generated at test time by `openstar_test_harness::fixture_library::install`: the
Library's own parser reads the `.txt`, and every Note becomes a sine tone at its
pitch and time, encoded by the real ffmpeg into the file the Song references. The
text and the audio cannot disagree, and no audio is ever committed.

| `.txt`                                             | What it is                                                                                                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Placeholder Artist - Steady Tone/steady-tone.txt` | Every scored Note (`:` and `*`) is an A (A3, A4, A5), so the fake mic's steady 440 Hz tone hits each of them, whenever the microphone opened. One Freestyle Note on another pitch. |
| `Placeholder Artist - Sine Melody/sine-melody.txt` | Notes on different pitches; also the Song of the Pitch track job tests.                                                                                                            |
| `Placeholder Duo - Two Voices/duet.txt`            | A 1.x duet (`#AUDIO`, `P1`/`P2`): the Voices take turns, then sing at once.                                                                                                        |
| `Placeholder Artist - Rejected/rejected.txt`       | `#VERSION:2.0.0`: rejected (`unsupportedVersion`), a Library problem.                                                                                                              |

- Server tests: `TestApp::builder().folders(AppFolders::with_fixture_library())`.
- `just e2e`: `openstar-harness fixture-library <songs>`; the e2e suite names the
  Songs in `FIXTURE_SONGS` (`e2e/fixtures.ts`).
- The fake microphone inputs are described in `fixtures/mic/`. Changing the
  steady-tone Song's pitches or the fake mic's tone fails
  `crates/test-harness/tests/fake_mic.rs` until they agree again.
- The edge cases of the Library scan have their own Library in
  `fixtures/library-scan/`.
