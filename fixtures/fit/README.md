# Fit cases

Cases for the fit module (`web/src/fit/fit.ts`): the match measure, Fit to the
singing and Line suggestions. Vitest runs them (`web/src/fit/fit.test.ts`) in
`just check`. No audio is committed: each case describes how a synthetic singer sings
a made-up melody, and the test renders the Pitch track from that.

## `match-cases.json`: the match measure by hand

One Note (`kind`, `pitch` in semitones from C4) sung for its whole length at one
steady `frameHz` (0 = unvoiced), and its expected match share: 1, 0, or `null` for a
Note that never counts (Rap, Golden rap, Freestyle).

## `melody.json`: the shared melody

98 Notes on 14 Lines of one Voice, every kind of Note, placeholder pitches only. The
fields are the fit module's `FitNote`: `voice` and `line` are indices into the
parsed Song's Voices and that Voice's Lines, `start` and `length` are in Beats from
`#GAP`, `pitch` is in semitones from C4.

## The other `*.json`: one sung Song each

| Field     | Meaning                                                                                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`    | `#GAP` (ms) and `#BPM` as the file writes them: the timing being fitted.                                                                                                                       |
| `sung`    | How the melody is really sung: its own `gap` and `bpm`, `transpose` (semitones every Note is sung away from its pitch; −12 is an octave lower) and `lineShifts` (Lines sung whole Beats late). |
| `seconds` | The length of the rendered track.                                                                                                                                                              |
| `melody`  | The melody file the case sings.                                                                                                                                                                |
| `expect`  | `fitToTheSinging` and `offsetOnly`: the `#GAP` and `#BPM` a fit must return (within 10 ms and 0.01, or exactly with `exact`); `lineSuggestions`: the Lines named on the file's timing.         |

### Rendering the track

One frame every 10 ms. Frame _i_ carries the Note sung at time (_i_ + ½) × 10 ms:
a Note sung over [t₀, t₁) voices the frames with t₀ < (_i_ + ½) × 10 ms ≤ t₁, which
are exactly the frames the match measure covers for a Note placed there. Normal and
Golden notes are sung at their pitch plus `transpose`, with a ±0.3 semitone vibrato
at 5.5 Hz; Rap and Golden rap notes are voiced a tritone away (they would never
match even if they counted); Freestyle notes and everything between Notes are
unvoiced.

Pick a `gap` and `bpm` for which Note edges do not fall on the 10 ms frame grid (as
in real singing). On the grid (for example `#GAP:2950`, `#BPM:300`) the share stays
exactly 1 over a few ms either way, and the fit search, which keeps the first of
equal candidates, then settles on a tempo up to 0.1 BPM away.
