# Scoring cases

Cases for Beats, reading placement and (from #54) Beat values. Vitest runs them
(`web/src/clock/beats.test.ts`, `web/src/clock/placement.test.ts`); a second
implementation (for example the server rescoring) runs the same files.

## `beats.json`: `beatAt`

`gapSeconds` and `beatsPerMinute` are the parser's normalised `SongHeaders` fields
(`#GAP` / 1000 and `#BPM` × 4); `file` shows the headers as written. Beat _b_ covers
Song time `[gapSeconds + b × 60 / beatsPerMinute, gapSeconds + (b + 1) × 60 / beatsPerMinute)`.

- `beatAt`: a Song time (seconds) and the Beat it falls in. A time exactly on a
  boundary belongs to the later Beat.
- `noteTimes`: a Beat and its start in Song time, rounded to 1e-9 s (the Vincent fix:
  the same Note under its old and new `GAP`/`BPM`).

## `placement/*.json`: Pitch readings onto Song time

Each file is one Song clock history and the readings placed against it.

| Field      | Meaning                                                                                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media`    | `video` or `audio`: what the clock follows.                                                                                                                                                                                               |
| `clock`    | Events in order, `at` in Stage ms (the clock is created at 0): `play`, `pause`, `stall`, `seek` (`position`, seconds), `setRate` (`rate`). A Restart is a `seek`. The resume countdown is the time between a `pause` and the next `play`. |
| `readings` | One case each, below.                                                                                                                                                                                                                     |

A reading case: `mic` (`phone`, `micBridge` or `localMic`; placement treats them
alike), `captureTime` (the window-centre stamp on the Stage's clock, ms),
`micDelayMs`, `placedAt` (the Stage time at which the reading reaches the Stage and
is placed, ms) and `songTime`: the expected Song time in seconds, or `null` when the
reading is dropped (its moment `captureTime − micDelayMs` falls inside a pause, stall
or countdown, before the latest Restart, before playback began, after it ended, or
more than 5 s before `placedAt`).

The clock is driven by events only, never by frame or `currentTime` observations, so
Song time runs exactly at the rate and every expected value can be worked out by hand.
Beat-value cases (#54) can add `pitch`, `clarity` and `loudnessDbfs` to a reading;
placement passes every field through unchanged.
