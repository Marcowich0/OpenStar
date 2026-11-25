# Fake microphone inputs

`fake-mic.json` describes the WAV files a fake microphone plays: Chromium's
`--use-file-for-fake-audio-capture` on a Phone in `just e2e`, and the Mic
bridge's WAV-file input. They are generated with the real ffmpeg by
`openstar_test_harness::fake_mic::write` (`openstar-harness fake-mic <dir>`;
`just e2e` writes them to the git-ignored `e2e/generated/mic/`), never
committed.

- `steadyTone`: a sine at `hz`, on the pitch class of every scored Note of the
  fixture Library's steady-tone Song (`fixtures/library/`). Chromium starts the
  file when the microphone opens, not when the Song starts, so only a Song on
  one pitch class is hit whatever the offset.
- `silence`: digital silence; a Phone that hears it scores 0.
- `multichannel`: `channels` channels, the steady tone on `toneChannel`
  (0-based) and silence on the others, for the Mic bridge's channel mapping.

Every file is `seconds` long at `sampleRate`. `hz × seconds` is a whole number,
so a looped file has no click. `crates/test-harness/tests/fake_mic.rs` checks
the files against this description and the steady tone against the Song.
