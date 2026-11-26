# Vocadito excerpts

Five short excerpts of real solo singing from Vocadito (CC BY 4.0; source,
authors and changes in `ATTRIBUTION.md`) with their hand-corrected f0. They
check that the pitch detector stays accurate on real voices, not just on the
synthetic tones in `fixtures/detector/`.

| File          | Singer | Language          | f0 range   |
| ------------- | ------ | ----------------- | ---------- |
| `vocadito_2`  | S2     | Spanish           | 345–416 Hz |
| `vocadito_4`  | S3     | Catalan/Valencian | 95–155 Hz  |
| `vocadito_6`  | S5     | English           | 203–377 Hz |
| `vocadito_26` | S21    | French            | 76–153 Hz  |
| `vocadito_35` | S28    | Mandarin          | 97–186 Hz  |

## Files

- `vocadito_<n>.wav`: 3.0 s, 16-bit mono PCM, 44.1 kHz.
- `vocadito_<n>_f0.csv`: one row per 256-sample frame (5.8 ms):
  `time in seconds,f0 in Hz`, from 0 s; `0.0` Hz is unvoiced.
- `floors.json`: the accuracy floors, per excerpt (`excerptMinPct`, keyed by
  the file name without extension) and over all voiced frames together
  (`overallMinPct`).

## The test

`web/src/pitch/vocadito/vocaditoAccuracy.test.ts` (Vitest, in `just check`)
runs each excerpt through the pitch worklet's real processor and the
`detector-wasm` module, 128 frames per block. Each voiced reference frame is
judged by the reading whose window centre (end frame − 1024) is nearest in
time: a hit when that reading's pitch, folded to the reference's octave, is
within 50 cents; an unvoiced reading is a miss. The share of hits must stay at
or above its floor, per excerpt and overall.

The floors were set from the first measured run and **only ever rise**
(`fixtures/README.md`): when the detector gets better, raise them to the new
values rounded down to 0.1; lowering one is a spec change, not a test fix.
Accuracy over a backing track is not tested.

A new excerpt needs its `.wav`, its `_f0.csv`, a row in `ATTRIBUTION.md` and a
floor; the test fails when an excerpt has no floor.
