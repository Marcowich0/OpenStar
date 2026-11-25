# Scoring cases

Cases for Beats, reading placement and (from #54) Beat values and the scorer. Vitest runs them
(`web/src/clock/beats.test.ts`, `web/src/clock/placement.test.ts`,
`web/src/scoring/beatValues.test.ts`, `web/src/scoring/scorer.test.ts`); a second
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
Placement passes every field of a reading through unchanged, so the Beat-value
cases below use the same reading shape plus the Pitch reading's own fields.

## `beatValues/*.json`: Beat values

Each file is one Mic's readings and the Beat values they give, under a steady clock:
a reading's Song time (seconds) is `(captureTime − micDelayMs − songStartMs) / 1000`.

| Field                          | Meaning                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `gapSeconds`, `beatsPerMinute` | The Beat grid, as in `beats.json`; `file` shows the headers as written.                                                           |
| `songStartMs`                  | The Stage time (ms) at which Song time is 0.                                                                                      |
| `micDelayMs`                   | The Mic's Mic delay.                                                                                                              |
| `micThresholdDbfs`             | The Mic's effective Mic threshold, fixed for the Song.                                                                            |
| `firstBeat`, `lastBeat`        | The Beat range, inclusive; readings outside it are ignored.                                                                       |
| `readings`                     | `captureTime` (ms), `pitch` (fractional MIDI note number or `null`), `clarity` (0–1) and `loudness` (dBFS), as in `PitchReading`. |
| `beatValues`                   | The expected value of each Beat in the range, in order, as the generated `BeatValue`: `noVoice`, `voiceWithoutPitch` or `pitch`.  |
| `comment`                      | Optional: how the expected values were worked out by hand.                                                                        |

The rules (#54): Beat _b_ takes every reading in `[start of b, start of b + 1)`. A reading
passes the Mic threshold at or above it, and is voiced when it also has a pitch and
clarity ≥ 0.8. With _n_ readings and _h_ = ⌈_n_ / 2⌉: _n_ = 0 → no voice; ≥ _h_ voiced →
pitch, the lower median (index ⌊(_k_ − 1) / 2⌋ of the _k_ voiced pitches sorted
ascending); else ≥ _h_ passing the threshold → voice without pitch; else no voice.

## `scorer/*.json`: judging Beats against a Voice's Notes

Each file is one Song's Voices and one or more Players, each scored alone against
one Voice from stored Beat values.

| Field                          | Meaning                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gapSeconds`, `beatsPerMinute` | The Beat grid, as in `beats.json`; `file` shows the headers as written.                                                                                    |
| `startSeconds`                 | `#START` in seconds, or `null`. A Note whose first Beat starts before it is not scored.                                                                    |
| `voices`                       | The parsed Song's Voices: `lines`, each with `notes` (`kind` as the generated `NoteKind`, `start` and `length` in Beats, `pitch` with 0 = C4, as written). |
| `players[].voice`              | The index of the Voice the Player sings.                                                                                                                   |
| `players[].difficulty`         | `easy`, `medium` or `hard`.                                                                                                                                |
| `players[].range`              | Optional Beat range `{ firstBeat, lastBeat }`, both included; absent means the whole Voice.                                                                |
| `players[].firstBeat`          | The Beat the first stored value belongs to; the values follow one per Beat.                                                                                |
| `players[].beatValues`         | The stored Beat values, compactly: `null` no voice, `"voice"` voice without pitch, a number a pitch (fractional MIDI note number).                         |
| `players[].expected`           | The range used (`firstBeat`, `lastBeat`), `voiceValue`, the `notes` and `golden` sums, and the judged Beats split into `hitBeats` and `missedBeats`.       |
| `comment`                      | Optional, at file or Player level: how the expected values were worked out by hand.                                                                        |

The rules (#54): a scored Note has factor > 0 (Normal 1, Golden 2, Rap 1, Golden Rap 2,
Freestyle 0), length > 0, lies wholly inside the range and does not start before
`#START`. voiceValue = Σ length × factor over them; a hit Beat earns 9000 / voiceValue ×
factor, to the Notes sum (Normal, Rap) or the golden sum (Golden, Golden Rap). A Beat is
judged once, for the first scored Note covering it in the Voice's Note order; Beats no
scored Note covers are not judged. Rap and Golden Rap hit on voice without pitch or a
pitch; Normal and Golden hit on a pitch with |d'| ≤ tolerance (Easy 250, Medium 150,
Hard 50 cents), d = (sung − Note pitch) × 100, d' = d − 1200 × ⌊(d + 600) / 1200⌋. The
whole Voice runs from the first Beat of its first Note to the last Beat of its last Note.
