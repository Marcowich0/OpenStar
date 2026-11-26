# Recorded Pitch readings

Real Pitch readings from a Phone, saved by the Phone mic latency prototype
(wayfinder #10, branch `prototype/phone-mic-latency`) at commit `b61f2dc`, from
`prototypes/phone-mic-latency/results/`. Readings and the run metadata replay
needs only: no audio, no lyrics. All were recorded on one Android Phone
(OnePlus 12, Chrome 157).

They feed two things:

- the **Beat-value regression test** (`web/src/scoring/readingsRegression.test.ts`,
  in `just check`);
- the **`?perf&lanes=8` synthetic lanes**, which replay them as Players' readings.

## The runs

Each prototype run file held one or more melody tests; each melody test is one
file here, labelled by `kind`. The Stage played the same 16-tone sawtooth melody
in each.

- **`bleed`**: nobody sang; the Phone heard only the Stage's speakers.
- **`singing`**: someone sang along with the melody.

| File                             | Kind    | Echo cancellation | Mic delay (ms) |
| -------------------------------- | ------- | ----------------- | -------------- |
| `run-1795538002867-bleed.json`   | bleed   | off               | 268.7          |
| `run-1795538002867-singing.json` | singing | off               | 268.7          |
| `run-1795539021796-bleed.json`   | bleed   | off               | 335.2          |
| `run-1795539383810-bleed.json`   | bleed   | off               | 329            |
| `run-1795539383810-singing.json` | singing | off               | 329            |
| `run-1795539764423-bleed.json`   | bleed   | on                | 73.8           |
| `run-1795539764423-singing.json` | singing | on                | 73.8           |
| `run-1795539929216-bleed.json`   | bleed   | on                | 105.4          |
| `run-1795539929216-singing.json` | singing | on                | 105.4          |
| `run-1795540001045-bleed.json`   | bleed   | on                | 96.9           |
| `run-1795540001045-singing.json` | singing | on                | 96.9           |

The run `run-1795539021796` has no singing test.

## Format: `run-*.json`

| Field            | Meaning                                                                                                                                                                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`           | `bleed` or `singing`.                                                                                                                                                                                                                                                                                                  |
| `source`         | Where it came from: `commit`, `file` (the prototype run file), `test` (the melody test's start, its id in that file), `phoneId`, `device`, and the Phone's `echoCancellation`, `noiseSuppression` and `autoGainControl`.                                                                                               |
| `micKind`        | Always `phone`.                                                                                                                                                                                                                                                                                                        |
| `micDelayMs`     | The Mic delay to place with: the prototype's beep-test loop median for that Phone, measured just before.                                                                                                                                                                                                               |
| `notes`          | The melody as played: `startMs`, `endMs` (Song time, ms) and `midi` (MIDI note number). Every boundary is a multiple of 50 ms: tone _i_ runs from _i_ × 1000 to _i_ × 1000 + 900 ms.                                                                                                                                   |
| `readingColumns` | `["captureMs", "pitch", "clarity", "loudness"]`: the order of each reading row.                                                                                                                                                                                                                                        |
| `readings`       | One row per reading, in capture order, from 1 s before the first tone to 1.5 s after the last. `captureMs`: the window-centre stamp on the Stage's clock, ms, with the first tone's start at 0. `pitch`, `clarity`, `loudness` as in the generated `PitchReading`: fractional MIDI note number (or `null`), 0–1, dBFS. |

The Song clock is steady and starts at the first tone, so a reading's Song time
(seconds) is `(captureMs − micDelayMs) / 1000`. `pitch` is `null` on the few
readings where the prototype's detector (`pitchy`, McLeod) reported no frequency;
otherwise clarity tells unvoiced readings apart. About 92 readings a second.

**Synthetic lanes** replay a run by sending each row as a Pitch reading at
`captureMs` after the lane's start (with `micDelayMs` as its Mic delay, or by
placing `captureMs − micDelayMs` directly), against a Song whose Notes are
`notes`. The rows are 18–19 s long; a lane loops them, shifting `captureMs` by
the run's length on each pass.

## The regression test

Each run is placed on a 50 ms Beat grid (`#GAP:0`, a Beat of 50 ms), as in the
replay that set the scoring thresholds (#22), and goes through `beatValues` at the
Phone fallback Mic threshold (`MIC_THRESHOLD.phoneFallbackDbfs`, −30 dBFS) with
the scoring constants of `SCORING`. Only Beats inside the `notes` count (18 per
tone, 288 per run).

- **Bleed runs** hit at most `bleedHitBeatsMaxPct` (4 %) of their Beats. A hit is
  `beatHits` for a Normal Note at Medium (±150 cents, octave folded), the
  prototype's own hit rule. Without the Mic threshold the same runs hit more than
  half their Beats, so the threshold is what keeps Bleed out.
- **Singing runs** have at least `singingVoicedBeatsMinPct` of their Beats
  voiced (a `pitch` Beat value).

`floors.json` holds both numbers. Measured on 2026-11-26: every Bleed run hit 0 %;
singing runs were voiced on 29.9, 63.2, 60.4, 66.3 and 69.1 % of Beats (in the
table's order). The floor, 29.8 %, was set from that first passing run.
**It only ever rises** (fixtures rule 5): raise it when the code gets better;
lowering it is a spec change, not a test fix.
