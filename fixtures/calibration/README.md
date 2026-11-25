# Calibration cases

Synthetic Pitch reading streams from a Calibration run and what the Calibration
analysis returns for each Mic (#95, rules in v1 spec #52). Vitest runs them in
`web/src/calibration/calibrationAnalysis.test.ts`; a second implementation runs the
same files. No audio is involved: the readings are written as the detector would
send them.

## Format

Each file is one run: one tone schedule and one OpenStar volume, and one or more Mics
analysed against it (each Mic alone).

| Field               | Meaning                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`       | What the file covers.                                                                                                                                                |
| `toneOutputTimesMs` | Each tone's reported output time on the Stage's clock (ms). Every file uses 8 tones, 600 ms from start to start.                                                     |
| `volume`            | The OpenStar volume (0 to 100) during the run.                                                                                                                       |
| `mics[].name`       | The case's name.                                                                                                                                                     |
| `mics[].comment`    | How the expected values were worked out by hand.                                                                                                                     |
| `mics[].readings`   | The Mic's Pitch readings, each `[captureMs, pitch, clarity, loudness]` as in `PitchReading`: window-centre stamp (ms), MIDI note number or `null`, 0–1, dBFS.        |
| `mics[].expected`   | `{ "result": "calibrated", micDelayMs, bleedLevelDbfs, tonesHeard }` (bleed level at the reference volume, to 1e-6) or `{ "result": "failed", reason, tonesHeard }`. |

`reason` is `tooFewTones` or `delaysTooSpread`. A failed result carries nothing else.

## The rules

- A reading **counts for a tone** when its capture time is from 150 ms before to 700 ms
  after the tone's output time (both ends included), its pitch is within ±50 cents of
  A4 (MIDI 69) after octave folding (both ends included), and its clarity is ≥ 0.8. A
  reading inside two tones' windows counts for the later tone.
- A tone's **delay** is the capture time of its earliest counting reading minus the
  tone's output time. A tone with no counting reading is not heard.
- Fewer than 5 tones heard → `tooFewTones`. Otherwise a **sample** standard deviation
  (divided by n − 1, as in the measurements behind the limit) of the delays above
  25 ms → `delaysTooSpread`.
- The **Mic delay** is the median of the delays (the mean of the middle two for an even
  count).
- The **bleed level** takes every reading, whatever its pitch or clarity, whose capture
  time minus the Mic delay is in `[output time, output time + 200 ms)` of one of the
  tones; it is the nearest-rank 95th percentile of their loudness (the ⌈0.95 n⌉-th
  smallest of n), minus the volume's level `40 log10(volume / 80)` (volume 0 counts
  as 5).
