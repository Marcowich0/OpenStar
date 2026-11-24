# How UltraStar Deluxe detects pitch and scores

Research for issue #3. Every claim is read from the UltraStar Deluxe (USDX) Pascal
source at commit
[`e06b7b7`](https://github.com/UltraStar-Deluxe/USDX/tree/e06b7b7ceff13612f6c5f716b4acedadd4a5f141)
(`master`, 2026-11-23, version string `2026.11.0+dev` in `src/base/UConfig.pas:131`).
References are `file:line` in that commit. Anything not read from the source is
listed under [Unverified](#unverified).

## Summary

- Pitch is found with a **circular average magnitude difference function (CAMDF)**
  over the newest **4096 samples** of 16-bit mono audio, tested at only **49
  candidate pitches** (the semitones C2 to C6). The best candidate wins. There is
  no interpolation, filtering, windowing or confidence measure.
- The only "is anyone singing" test is a **peak volume gate** (default 10 % of
  full scale).
- Detection runs **once per beat**, not continuously. A beat is a quarter of a
  file beat: `15 / BPM` seconds.
- Only the **pitch class** (0 to 11) is compared with the note. The octave is
  ignored: the sung tone is moved to the octave nearest the note.
- A beat is hit if the sung tone is within **2 / 1 / 0 semitones** of the note on
  Easy / Medium / Hard. Rap notes are hit by any sound above the volume gate.
  Freestyle notes are never scored.
- The maximum is **10000**: 9000 for notes, 1000 for line bonus. Golden notes are
  worth twice a normal note per beat. Scores are kept as reals and rounded to the
  nearest integer for display and storage; there is no rounding to tens.

## 1. Audio capture

| Fact | Value | Source |
| --- | --- | --- |
| Sample format | signed 16-bit; other formats are not analysed | `src/base/URecord.pas:323-326` |
| Channels | each device channel is split out to its own mono buffer, one per player | `src/base/URecord.pas:813-873`, `:593-599` |
| Analysis buffer | `array[0..4095] of smallint`, "newest 4096 samples (MUST BE POWER OF TWO!)" | `src/base/URecord.pas:84` |
| Analysed length | the whole buffer (`AnalysisBufferSize := Length(AnalysisBuffer)`) | `src/base/URecord.pas:277` |
| Buffer update | a sliding window: old samples shift left, new ones are appended | `src/base/URecord.pas:333-350` |
| Sample rate | whatever the device opens with, not a fixed rate | see below |
| Mic boost | samples multiplied by 1, 2, 4 or 8 and clipped to int16; default Off | `src/base/URecord.pas:550-588`, `src/base/UIni.pas:1194` |

Sample rate by backend:

- SDL asks for 44100 Hz but lets the device change it
  (`SDL_AUDIO_ALLOW_FREQUENCY_CHANGE`) and uses the rate it gets
  (`src/media/UAudioInput_SDL.pas:163-192`).
- PortAudio uses the device's `defaultSampleRate`
  (`src/media/UAudioInput_Portaudio.pas:393`).
- BASS uses the device's reported rate, or 44100 Hz
  (`src/media/UAudioInput_Bass.pas:435-439`).

So the window is 4096 samples whatever the rate: 92.9 ms at 44.1 kHz, 85.3 ms at
48 kHz (arithmetic, not stated in the source).

## 2. Pitch detection

Entry point: `TCaptureBuffer.AnalyzeBuffer` (`src/base/URecord.pas:367-407`).

### 2.1 Volume gate

```
MaxVolume = max(|x[n]|) / 32768        over all 4096 samples
if MaxVolume >= Threshold: run pitch detection, ToneValid = true
else:                      ToneValid = false, Tone = ToneAbs = -1
```

- `src/base/URecord.pas:374-402`.
- `Threshold` is a user setting from
  `IThresholdVals = (0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.60)`
  (`src/base/UIni.pas:395`). The default index is 1, so **0.10**
  (`src/base/UIni.pas:1196`).
- `AnalyzePitch` always returns `true` (`src/base/URecord.pas:460`). There is no
  voiced/unvoiced test and no confidence value: any sound above the gate yields a
  tone.

### 2.2 Candidate pitches

```
BaseToneFreq = 440     // A4
NumHalftones = 49      // C2 to C6
Frequencies[i] = 440 * 2^((i - 33) / 12)        i = 0..48   (i = 0 is C2 = 65.4064 Hz)
Delays[i]      = Round(SampleRate / Frequencies[i])          // integer samples
```

- `src/base/URecord.pas:46-47`, `:423-433`.
- The delays are whole samples. At 44.1 kHz they run from 674 samples (C2) down
  to 42 samples (C6) (arithmetic).

### 2.3 The algorithm (CAMDF)

The call is `AnalyzePitch(PDA_CAMDF)` (`src/base/URecord.pas:399`). The plain AMDF
variant exists but its call is commented out (`:396`).

```
for i in 0..48:
    D[i] = (1/N) * sum over n = 0..N-1 of | x[(n + Delays[i]) & (N-1)] - x[n] |
ToneAbs = index of the minimum D[i]
Tone    = ToneAbs mod 12
```

- `N = 4096`. The index wraps around the buffer (`and (AnalysisBufferSize-1)`),
  which is why the size must be a power of two (`src/base/URecord.pas:493-515`).
- The minimum search uses `<=`, so on a tie the **highest** candidate wins
  (`src/base/URecord.pas:409-421`).
- `Tone` is the pitch class, 0 = C to 11 = B. `ToneAbs` is the semitone index from
  C2 (`src/base/URecord.pas:92-93`, `:459`, `:537-545`).
- Nothing else is done: no window function, no low-pass or high-pass filter, no
  interpolation between candidates, no smoothing across frames.

The source cites the CAMDF definition as equation (4) of the paper linked at
`src/base/URecord.pas:489-492`.

### 2.4 Octave handling

The detector returns an absolute semitone (`ToneAbs`), but scoring only reads
`Tone` (0 to 11). The sung tone is then moved by whole octaves until it is within
6 semitones of the note:

```
while Tone - NoteTone >  6: Tone -= 12
while Tone - NoteTone < -6: Tone += 12
```

- `src/base/UNote.pas:547-552`.
- A singer an octave (or several) off is scored as if in the right octave.
  Octave errors of the detector do not matter either.
- A note's `Tone` is the pitch number from the `.txt` file, unchanged
  (`src/base/USong.pas:1636`, `Notes[HighNote].Tone := NoteP`). Since detected
  tone 0 is C, a file pitch of 0 is a C, and only `pitch mod 12` matters.

## 3. When detection runs

### 3.1 Beats

- The internal BPM is the file's `#BPM` times 4
  (`src/base/USong.pas:1217`, `Mult := 1` at `:675`). Note start and length are
  in these beats (`src/base/USong.pas:828`).
- `GetMidBeat(Time) = Time * BPM / 60` (`src/base/UNote.pas:247-258`). One beat
  therefore lasts `60 / (4 * fileBPM) = 15 / fileBPM` seconds.

### 3.2 The detection beat

```
MidBeatD     = -0.5 + GetMidBeat(LyricsTime - (GAP + MicDelay) / 1000)
CurrentBeatD = Floor(MidBeatD)
```

- `src/base/UBeatTimer.pas:294-297`. `StartTime` is the song's `#GAP` in
  milliseconds (`src/screens/controllers/UScreenSingController.pas:1237`).
- `MicDelay` is a global setting in milliseconds, default **140**
  (`src/base/UIni.pas:1574`).
- Beat `b` is therefore evaluated when the song time first reaches
  `GAP + MicDelay + (b + 0.5) beats`: half a beat after the beat started, plus the
  mic delay. The buffer analysed at that moment is the 4096 samples that ended
  then.

### 3.3 The loop

`Sing` runs once per rendered frame (`src/screens/views/UScreenSingView.pas:913`).
When the detection beat changed and is not negative, it calls `NewBeatDetect`,
which calls `NewNote` (`src/base/UNote.pas:313-315`, `:426`). `NewNote` loops over
every beat from `OldBeatD + 1` to `CurrentBeatD`, and for each beat and each
player calls `AnalyzeBuffer` (`src/base/UNote.pas:481-525`).

Consequences:

- One pitch reading per beat per player. A note of length `n` gets `n` readings.
- If a frame spans several beats, the same buffer is analysed once for each, so
  all those beats get the same tone.
- At a high BPM a beat is shorter than the 93 ms window, so successive readings
  overlap heavily.

## 4. Scoring a beat

For each beat and player (`src/base/UNote.pas:484-592`):

1. **Find an active note.** Search the previous and the current line for a note
   with `StartBeat <= beat <= StartBeat + Duration - 1`, `Duration > 0` and a type
   other than freestyle (`:476-507`). If there is none, nothing happens.
2. **Need a tone.** If the volume gate failed (`ToneValid` false), nothing happens
   (`:532`).
3. **Fold the octave** as in 2.4.
4. **Test the hit:**

   ```
   Range = 2 - Level                      // Level: 0 easy, 1 medium, 2 hard
   hit   = |NoteTone - Tone| <= Range  or  NoteType is Rap or RapGolden
   ```

   `src/base/UNote.pas:557-563`; levels at `:80` and `src/base/UIni.pas:353`.
5. **Award points** for a hit:

   ```
   CurNotePoints = (9000 / Track.ScoreValue) * ScoreFactor[NoteType]
   ```

   `src/base/UNote.pas:575-589`. Normal and rap points go to `Score`, golden and
   rap-golden points to `ScoreGolden`.

### 4.1 Difficulty tolerance

| Difficulty | `Level` | Tolerance (semitones, either side) |
| --- | --- | --- |
| Easy | 0 | 2 |
| Medium | 1 | 1 |
| Hard | 2 | 0 |

- The level is per player in normal and medley mode. In the other (party) modes
  the global `Ini.Difficulty` is used (`src/base/UNote.pas:557-560`). The default
  is Medium (`src/base/UIni.pas:1552`).
- Difficulty changes nothing else in scoring: not the points, not the line bonus.

### 4.2 Note types

`TNoteType = (ntFreestyle, ntNormal, ntGolden, ntRap, ntRapGolden)` with
`ScoreFactor = (0, 1, 2, 1, 2)` (`src/base/UMusic.pas:50`, `:82`).

| `.txt` | Type | Factor | Pitch checked | Counted in |
| --- | --- | --- | --- | --- |
| `:` | Normal | 1 | yes | `Score` |
| `*` | Golden | 2 | yes | `ScoreGolden` |
| `R` | Rap | 1 | no, any sound above the gate hits | `Score` |
| `G` | Rap golden | 2 | no, any sound above the gate hits | `ScoreGolden` |
| `F` | Freestyle | 0 | never scored | nothing |

- Type mapping: `src/base/USong.pas:1614-1627`.
- Freestyle notes are skipped when looking for an active note
  (`src/base/UNote.pas:500`) and add nothing to `ScoreValue`.
- A "rap to freestyle" option on the song screen turns `R` notes into freestyle.
  `G` notes stay rap-golden (`src/base/USong.pas:1619-1626`).

### 4.3 Points per beat

```
Note value       = Duration * ScoreFactor[NoteType]
Track.ScoreValue = sum of note values over the whole track
Line.ScoreValue  = sum of note values over the line
points per hit beat = 9000 / Track.ScoreValue * ScoreFactor[NoteType]
```

- `src/base/USong.pas:1630-1634`; constants at `src/base/UNote.pas:146-147`
  (`MAX_SONG_SCORE = 10000`, `MAX_SONG_LINE_BONUS = 1000`).
- Hitting every beat of every scored note gives exactly 9000.
- Points are per beat, so a half-sung note earns half its points.
- In a duet each track has its own `ScoreValue`; player `i` sings track
  `i mod 2` (`src/base/UNote.pas:486`).

## 5. Line bonus

`OnSentenceEnd` runs when the detection beat reaches the end of a line's last
note (`StartBeat + Duration`) (`src/base/UNote.pas:428-440`). For a line with
`ScoreValue > 0` (`src/screens/controllers/UScreenSingController.pas:1745-1800`):

```
MaxLineScore   = 9000 * Line.ScoreValue / Track.ScoreValue
LineScore      = (Score + ScoreGolden) - ScoreLast       // points gained since the last line end
LinePerfection = 1                                 if MaxLineScore <= 2
               = LineScore / (MaxLineScore - 2)    otherwise, clamped to 0..1
LineBonus      = 1000 / (number of lines - number of lines with ScoreValue 0)
ScoreLine     += LineBonus * LinePerfection
ScoreLast      = Score + ScoreGolden
```

- Every scored line is worth the same bonus, whatever its length.
- The `- 2` gives a small margin: a line counts as perfect two points short of
  its maximum.
- Lines with no scored notes (all freestyle) give no bonus and are left out of
  the divisor (`src/screens/controllers/UScreenSingController.pas:1289-1308`).
- The pop-up rating shown is `Round(LinePerfection * 8)`, 0 to 8 (`:1743`,
  `:1792`). It is display only.

## 6. Totals and rounding

- `Score`, `ScoreGolden` and `ScoreLine` are reals and accumulate unrounded
  (`src/base/UNote.pas:66-68`).
- `ScoreTotalInt = round(Score + ScoreGolden + ScoreLine)`. Each part is also
  rounded on its own, then one part is moved by 1 so the three add up to the
  total: golden is lowered first, then notes, then line bonus; notes are raised
  first (`src/base/UNote.pas:196-225`).
- Maximum: 9000 + 1000 = **10000**. There is no rounding to tens anywhere in this
  code.
- The high score saved is `ScoreTotalInt`, stored per difficulty level, and only
  if it is above 0, the song was sung to the end, and it is not a duet (unless
  the `DuetScores` setting is on)
  (`src/screens/controllers/UScreenSingController.pas:1903-1910`).
- "Sung to the end" means the song time passed the end of the last scored note
  of each sung track. It is never set while "rap to freestyle" is on
  (`src/screens/views/UScreenSingView.pas:843-848`, `src/base/USong.pas:892`).

## 7. Reimplementation recipe

```
per player, per detection beat b (b = floor(-0.5 + (t - (GAP + micDelay)/1000) * fileBPM*4/60), b >= 0):
  note = scored note (not freestyle, duration > 0) with start <= b < start + duration,
         looked up in the previous and the current line
  if no note: continue
  x = newest 4096 int16 mono samples
  if max|x| / 32768 < threshold (default 0.10): continue
  for i in 0..48: delay = round(sampleRate / (440 * 2^((i-33)/12)))
                  D[i] = mean over n of |x[(n + delay) mod 4096] - x[n]|
  tone = (argmin D, last one on ties) mod 12
  shift tone by 12 until -6 <= tone - note.tone <= 6
  if note is rap or |note.tone - tone| <= 2 - level:
      add 9000 / trackValue * factor(note) to score (golden kinds to the golden sum)

at the end of each line with lineValue > 0:
  max  = 9000 * lineValue / trackValue
  perf = max <= 2 ? 1 : clamp((pointsThisLine) / (max - 2), 0, 1)
  lineBonus += 1000 / scoredLineCount * perf

total = round(score + golden + lineBonus)        // 0..10000
```

## 8. Facts later decisions most depend on

- **The work per reading is small and fixed**: 49 candidates times 4096 samples,
  integer arithmetic, once per beat. It fits a browser `AudioWorklet` or a
  server.
- **The sample rate is not fixed.** Delays are computed from the device's rate,
  so the browser's native rate (often 48 kHz) can be used as is. The window is
  4096 samples at any rate.
- **Detection is beat-driven.** A reading must be available for each beat at
  `GAP + micDelay + (b + 0.5) beats`. Latency calibration in USDX is one number,
  `MicDelay` (default 140 ms), shared by all mics; OpenStar wants it per mic.
- **Octave never matters**, so a detector only has to get the pitch class right.
- **Scoring is deterministic given one tone per beat.** A scorer that takes
  `(notes, tone per beat, level)` can be tested against USDX without audio.
- **Difficulty is only the semitone tolerance** (2 / 1 / 0), so it can differ per
  player with no other state.
- **The score splits into three sums** (notes, golden, line bonus) that a results
  screen can show separately, as USDX does.

## Unverified

- **Rounding mode.** `round` is Free Pascal's `Round`. That it rounds halves to
  the nearest even number (banker's rounding) is recalled from the Free Pascal
  documentation, not checked for this ticket. It can change a total by 1 only on
  an exact `.5`.
- **Older versions.** That older USDX releases rounded scores to tens is a
  recollection, not checked. The current source does not.
- **Detection quality.** How well CAMDF on 49 integer delays tracks real singing
  (the delay for C6 is only about 42 samples, so high candidates are coarse) was
  not measured. The source itself notes the buffer may be too small for the
  lowest tones (`src/base/URecord.pas:443-445`).
- **Frame rate.** That `Sing` runs once per rendered frame is read from the call
  site in the draw routine; the actual frame rate and its effect on reading
  times were not measured.
- **Other backends and platforms.** Which audio input backend a given build uses
  was not checked.
