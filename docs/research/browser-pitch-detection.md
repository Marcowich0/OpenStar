# Pitch detection options for the browser

Research for issue #5. Researched 2026-11-24.

**Question.** Which pitch detection approaches are viable in a browser in real time for sung voice, and how do the candidates and their JavaScript and WebAssembly implementations compare on accuracy for singing, latency, CPU cost on a mid-range phone, licence and maintenance?

Claims carry a source in brackets; the sources are listed at the end. A claim marked **unverified** has no primary source behind it. A claim marked **measured here** comes from the timing run described in [CPU cost](#cpu-cost).

## Answer

1. **A classical time-domain detector is enough, and the McLeod Pitch Method (MPM) is the best fit.** It needs only two periods of signal, gives a 0-to-1 "clarity" value that doubles as a voiced/unvoiced gate, and costs O(n log n) with an FFT [MPM]. YIN is equivalent in quality and cost when implemented with an FFT [YIN].
2. **`pitchy` is the implementation to start from.** It is MPM in pure JavaScript with one small dependency, permissively licensed, and it took 0.08 ms per 2048-sample frame on a desktop core (measured here). The algorithm is also small enough to own: MPM is four pages [MPM].
3. **The scoring task is far easier than the benchmarks.** UltraStar Deluxe (USDX) folds the sung tone into the octave of the target note and accepts it within 2, 1 or 0 semitones depending on difficulty [USDX-note]. Octave errors, the main failure of classical detectors, therefore cost nothing, and cent-level accuracy is not needed.
4. **Neural models are not needed for v1 and each has a blocker.** CREPE is slower than real time on one desktop core [RIN][BENCH]. SwiftF0 is fast and has a browser demo, but its streaming mode needs 176 ms of lookahead [SWIFT-README]. PESTO is LGPL-3.0 and has no JavaScript package that I found [PESTO-README].
5. **Three JavaScript options carry copyleft terms**: `pitchfinder` (declares "GNU v3"), `aubiojs` (wraps aubio, GPL-3.0) and `essentia.js` (AGPL-3.0). OpenStar is Apache-2.0, so each of these is a licensing decision, not a drop-in.
6. **The ticket's premise needs one correction.** USDX today does not use autocorrelation. It uses a circular average magnitude difference function (CAMDF) evaluated at 49 lags, one per semitone from C2 to C6 [USDX-record].

## What the task requires

- **Pitch range.** USDX searches C2 (65.4 Hz) to C6 (1046.5 Hz), 49 semitones [USDX-record].
- **Resolution.** USDX outputs an integer semitone, with no interpolation between lags [USDX-record].
- **Octave handling.** Before comparing, USDX shifts the sung tone by whole octaves until it is within 6 semitones of the target note [USDX-note].
- **Tolerance.** A note is hit when the difference is at most `2 - difficulty` semitones, so 2 on Easy, 1 on Medium and 0 on Hard [USDX-note][USDX-ini].
- **Voicing.** USDX has no voicing decision. It gates on peak volume against a configurable threshold (0.05 to 0.60 of full scale) and otherwise always reports a tone [USDX-record][USDX-ini].
- **Window.** USDX analyses the newest 4096 samples, which is 93 ms at 44.1 kHz and 85 ms at 48 kHz [USDX-record].

The consequence is that the benchmark figure closest to this task is raw chroma accuracy (octave-folded), not raw pitch accuracy, and that the 50-cent tolerance those benchmarks use is twice as strict as Hard difficulty needs to be in order to round to the right semitone.

## Algorithms

### CAMDF as USDX uses it

For each of 49 semitone lags it sums `|x[(n + lag) mod N] - x[n]|` over the 4096-sample buffer and picks the lag with the smallest sum [USDX-record]. The source file also holds a plain AMDF variant that is commented out [USDX-record].

- Cost is 49 x 4096 subtractions per frame: 0.12 ms on a desktop core (measured here).
- It cannot report anything between semitones, so a singer a quarter-tone flat is rounded either way. I found no published accuracy evaluation of this exact scheme (**unverified** how it compares to YIN or MPM on singing).
- Its octave errors are harmless under USDX's octave folding.
- It is what the behavioural reference does, so it is the baseline to match when verifying scoring against USDX.

### YIN

De Cheveigné and Kawahara, 2002 [YIN]. Six steps on top of the squared-difference function: cumulative mean normalisation, an absolute threshold (0.1), parabolic interpolation and a local search.

- On a speech database with laryngograph ground truth the gross error rate (estimate off by more than 20%) fell from 10.0% for plain autocorrelation to 0.50% with all six steps [YIN, Table I].
- "F0 estimation requires enough signal to cover twice the largest expected period" [YIN]. The paper's own statistics use a 25 ms window with a 40 Hz lower bound.
- Latency can be reduced to the largest period plus the found period, because step 4 can stop at the first acceptable dip [YIN, Sec. V].
- The paper states YIN "has been only informally evaluated on music" [YIN].
- The normalised difference at the chosen lag works as a confidence value [YIN, Sec. V].

### McLeod Pitch Method

McLeod and Wyvill, 2005 [MPM]. A normalised squared-difference function in the range -1 to 1, then the first peak above `k` times the highest peak, with `k` between 0.8 and 1.0, refined by parabolic interpolation.

- Built for the Tartini tool for "singers and instrumentalists", for real-time feedback at 44.1 kHz [MPM].
- Works "with as little as two periods", so "smaller window sizes can be used than in other algorithms", which the authors tie to following vibrato [MPM, Sec. 8].
- O((W + w) log(W + w)) through the FFT autocorrelation [MPM, Sec. 6].
- Typical windows are 512, 1024, 2048 or 4096 samples at 44.1 kHz with 75% overlap [MPM, Sec. 6].
- The value of the chosen peak is the "clarity" measure, "similar to the term voiced" [MPM, Sec. 7].
- The paper reports no quantitative accuracy figures. Its claims of accuracy rest on the authors' use with musicians (**unverified** against a labelled singing dataset in the paper itself).

### pYIN

Mauch and Dixon, 2014 [PYIN]. YIN run over a distribution of thresholds to produce several pitch candidates with probabilities, then a hidden Markov model decoded with Viterbi.

- Evaluated on over 30 hours of singing synthesised from the RWC pitch tracks, with a 2048-sample frame and 256-sample hop at 44.1 kHz. Median recall 0.977 to 0.984 against below 0.951 for YIN; octave errors 0.5% to 1.7% [PYIN, Sec. 3].
- The gain comes from the Viterbi pass over the whole track. Running it live needs a fixed-lag decoder, which adds delay. That is my reading of the method; the paper does not discuss online use.
- The reference implementation is a GPL-2.0 Vamp plugin in C++ [PYIN-REPO]. A C++ port exists under MIT but depends on mlpack [SEVAGH]. I found no JavaScript or WebAssembly package of pYIN (**unverified** that none exists).
- Its extra benefit, fewer octave errors, is the benefit octave folding already makes irrelevant.

### Neural models

| Model | Input and hop | Size | Speed on one CPU core | Licence | Browser status |
|---|---|---|---|---|---|
| CREPE [CREPE] | 1024 samples at 16 kHz (64 ms), 10 ms hop | 22.2 M parameters full, 487 k tiny [SPICE] | 0.4x real time [BENCH]; 1851 ms per second of audio [RIN] (full model) | MIT [CREPE-REPO] | TensorFlow.js demo in the repo's `gh-pages` branch, about 1.95 MB of weights; `ml5-library` wraps the same model [CREPE-WEB][ML5] |
| SPICE [SPICE] | 16 kHz, constant-Q transform with 512-sample hop (32 ms) | 2.38 M parameters, 180 k variant | not found | **unverified** | **unverified** |
| PESTO [PESTO] | constant-Q frames, 10 ms step in the README example | 28.9 k parameters | about 12x to 20x real time [PESTO-README][BENCH]; 0.7 ms per inference as ONNX [PESTO-README] | LGPL-3.0 | PyTorch with ONNX export; no JavaScript package found (**unverified** that none exists) |
| SwiftF0 [SWIFT] | 1024-sample window, 256 hop at 16 kHz (16 ms frames) | 14,386 parameters, 135 kB ONNX file (v0.3.0) | 180x real time; 16x with 20 ms chunks [SWIFT-README] | MIT | Live demo on ONNX Runtime Web [SWIFT-README]; no npm package found (**unverified**) |

SwiftF0's streaming mode makes a frame final only "once 176 ms of audio after it have arrived" [SWIFT-README]. That delay is larger than the whole analysis window of any classical candidate here.

## Accuracy on singing

The one evaluation I found that puts classical and neural estimators side by side on isolated singing with runtime is a 2026 preprint [RIN, Table 1]. MIR-1K is 1,000 isolated vocal tracks from Chinese pop songs. Tolerance is 50 cents, frame period 20 ms, runtime on one thread of an Intel Core i9-14900K.

| Estimator | Raw pitch accuracy | Raw chroma accuracy | Runtime, ms per second of audio |
|---|---|---|---|
| YIN, no smoothing | 94.90% | 95.95% | 2.1 |
| YIN with Viterbi (pYIN) | 98.64% | 99.06% | 13.3 |
| SWIPE | 96.39% | 96.92% | 49.2 |
| CREPE | 97.57% | 97.91% | 1851.0 |
| PESTO | 98.26% | 98.50% | 35.8 |

Read with these limits:

- It is a preprint whose subject is a smoothing method, not a benchmark paper, and it does not include MPM.
- MIR-1K's reference pitch was "initially extracted algorithmically" [SWIFT], CREPE's training data included MIR-1K [SPICE] and PESTO's published results come from a model trained on MIR-1K [PESTO], so the neural figures are optimistic.
- Other papers report different numbers on the same dataset because the setups differ: the SPICE paper gives CREPE 90.1% to 90.7% and SWIPE 86.6% [SPICE]; the PESTO paper gives CREPE 97.8% and PESTO 96.1% [PESTO, Table 1].
- Clean studio vocals are not a phone microphone in a living room with the backing track playing. On noise, the SwiftF0 paper reports pYIN's raw chroma accuracy at 87.77% at 10 dB SNR against 88.03% clean, averaged over its speech, singing and instrument test sets; CREPE scores 72.43% and 71.00% there [SWIFT, Tables 1 and 2]. That benchmark is by the SwiftF0 author.
- The CREPE paper, on synthesised instrument and voice stems, has pYIN at 91.9% and CREPE at 96.7% at 50 cents [CREPE, Table 1].

I found no published evaluation of any of these detectors on consumer-microphone karaoke singing with music bleed (**unverified** for every candidate). That gap is what a prototype would have to close.

## Latency

Window sizes at 48 kHz, the rate browsers commonly run the audio graph at (**unverified** per device; the rate comes from the `AudioContext`):

| Window | Duration | Lowest pitch with two periods in the window |
|---|---|---|
| 1024 | 21.3 ms | 93.8 Hz (about F#2) |
| 2048 | 42.7 ms | 46.9 Hz (below C2) |
| 4096 | 85.3 ms | 23.4 Hz |

The third column is my arithmetic from the two-period rule [YIN][MPM]. It means 1024 samples at 48 kHz cannot cover USDX's C2 lower bound and 2048 can.

- An estimate describes the window as a whole, so the delay it adds is roughly half the window: about 21 ms for 2048 samples, against about 43 ms for USDX's 4096. That is my derivation, not a sourced figure.
- The window slides. An `AudioWorklet` delivers 128-sample blocks [WEBAUDIO], so a new estimate can be produced every 2.7 ms at 48 kHz if wanted; MPM's authors use a hop of a quarter window [MPM].
- Detector delay is small next to microphone and network delay on a phone, which the latency tickets cover.

## CPU cost

No source reports timings for these detectors on a phone (**unverified** for a mid-range phone). What exists:

**Measured here.** Node.js 26.13 on one core of an AMD Ryzen 9 7900, synthetic 220 Hz harmonic tone with vibrato at 48 kHz, 400 calls after warm-up, milliseconds per frame:

| Implementation | 1024 | 2048 | 4096 |
|---|---|---|---|
| `pitchy` 4.1.0 (MPM, FFT) | 0.040 | 0.075 | 0.178 |
| `aubiojs` 0.2.1 `yinfft` (WebAssembly) | 0.113 | 0.231 | 0.464 |
| `aubiojs` 0.2.1 `yinfast` (WebAssembly) | 0.129 | 0.291 | 0.523 |
| `pitchfinder` 2.3.4 YIN | 0.217 | 0.902 | 3.590 |
| `pitchfinder` 2.3.4 Macleod | 0.317 | 1.264 | 5.009 |
| `pitchfinder` 2.3.4 AMDF | 3.651 | 10.176 | 20.403 |
| USDX-style CAMDF, 49 lags (my port) | 0.030 | 0.061 | 0.120 |

- This is a desktop CPU and a synthetic signal. It ranks the implementations; it does not predict a phone.
- `pitchfinder`'s YIN and Macleod quadruple when the window doubles, which is the O(n²) direct summation; `pitchy` and aubio scale near-linearly.
- At 50 estimates per second, `pitchy` at 2048 samples used 3.8 ms of CPU per second of audio on this machine. A phone core ten times slower would still spend under 4% of one core. The factor of ten is an assumption (**unverified**).
- Published desktop figures agree on order of magnitude: YIN at 2.1 ms per second of audio, PESTO at 35.8, CREPE at 1851 [RIN].
- CREPE's full model does not reach real time on one desktop core [RIN][BENCH]. The tiny model's speed in a phone browser is **unverified**.

## JavaScript and WebAssembly implementations

Checked on GitHub and the npm registry on 2026-11-24.

| Package | Algorithms | Form | Licence | Latest release | Last push |
|---|---|---|---|---|---|
| `pitchy` [PITCHY] | MPM | Pure JavaScript, ES module only, depends on `fft.js`, 33 kB unpacked | 0BSD in the repository; npm 4.1.0 declares MIT | 4.1.0, 2024-01-04 | 2026-10-13 |
| `pitchfinder` [PITCHFINDER] | YIN, Macleod, AMDF, Dynamic Wavelet | Pure JavaScript, no dependencies | `"GNU v3"` in `package.json`, no licence file in the repository | 2.3.4, 2025-12-16 | 2025-12-16 |
| `aubiojs` [AUBIOJS] | aubio's `yinfft` (default), `yin`, `yinfast`, `mcomb`, `fcomb`, `schmitt`, `specacf` [AUBIO] | aubio compiled with Emscripten, 427 kB unpacked | Repository says MIT; aubio itself is GPL-3.0 [AUBIO] | 0.2.1, 2022-11-08 | 2023-08-17 |
| `pitch-detection` Rust crate [ALESGENOVA] | MPM, YIN, autocorrelation | Rust, compiled to WebAssembly in the author's demo | MIT or Apache-2.0 | 0.3.0 | 2023-01-08 |
| `pitchlite` [PITCHLITE] | MPM | C++ and KissFFT compiled to WebAssembly, with an `AudioWorklet` example | MIT | no npm release found | 2023-07-16 |
| `essentia.js` [ESSENTIA] | Many, including YIN variants | C++ compiled to WebAssembly, 10 MB unpacked | AGPL-3.0 | 0.1.3, 2021-06-24 | 2025-12-10 |
| `ml5-library` `pitchDetection` [ML5] | CREPE | TensorFlow.js | MIT up to 2021, then the ml5.js licence | old library; no pitch detection found in the successor (**unverified**) | 2024-10-11 |

Notes:

- `pitchfinder`'s README says its algorithms were ported from TarsosDSP and its YIN from aubio [PITCHFINDER], which is where the GPL terms come from.
- `pitchy`'s own README describes the trade-off as "fast and accurate enough to be used in real-time applications such as tuners" [PITCHY]. It has had no release since January 2024; the algorithm is finished, so that reads as stable more than abandoned (my judgement).
- Weekly npm downloads for 2026-11-16 to 2026-11-22: `pitchy` 54,180, `pitchfinder` 26,219, `aubiojs` 7,536 [NPM].

### Prior art in a browser karaoke game

AllKaraoke, a browser karaoke game (its `package.json` declares MIT), reads 2048 samples from an `AnalyserNode` and passes them to `aubiojs` with the default `yinfft` method and tolerance 0.5 [ALLKARAOKE]. Its repository also holds a pure-JavaScript YIN strategy, derived from aubio and carrying aubio's GPL header, which `mic-input.tsx` does not use [ALLKARAOKE]. So a classical detector on a 2048-sample window is already in production use for this exact task.

## Comparison

| Candidate | Accuracy for singing | Window and added delay | CPU | Licence | Maintenance | Verdict |
|---|---|---|---|---|---|---|
| CAMDF at semitone lags (USDX) | Integer semitones only; no published evaluation (**unverified**) | 4096 samples, 85 to 93 ms | 0.12 ms per frame (measured here) | Algorithm is public; USDX code is GPL-2.0, so reimplement, do not copy | Own code | Viable; the reference behaviour to compare against |
| YIN | 94.9% raw pitch, 96.0% chroma on MIR-1K [RIN] | 2 periods; 2048 samples (43 ms) covers C2 at 48 kHz | 0.2 to 0.9 ms per frame in the libraries measured | Depends on implementation: `pitchfinder` GPL, aubio GPL | Own code or copyleft libraries | Viable if written in-house |
| **MPM** | No figures in the paper (**unverified**); same family as YIN | 2 periods; 2048 samples (43 ms) | 0.08 ms per frame with `pitchy` (measured here) | 0BSD or MIT (`pitchy`) | `pitchy` stable, last release 2024 | **Recommended** |
| pYIN | 98.6% raw pitch, 99.1% chroma on MIR-1K [RIN] | 2048 samples plus decoder lag when run live | About 6x YIN [RIN] | Reference is GPL-2.0; no browser package found | None for the browser | Not for v1: its gain is octave errors, which scoring ignores |
| CREPE | 97.6% raw pitch on MIR-1K [RIN]; below pYIN in [SWIFT] | 64 ms window | Full model slower than real time on a desktop core | MIT | Repository last pushed 2024 | Not viable on phones (tiny model **unverified**) |
| SPICE | 90.6% raw pitch on MIR-1K [SPICE] | 32 ms hop | not found | **unverified** | **unverified** | Not pursued |
| PESTO | 98.3% raw pitch on MIR-1K [RIN] | 10 ms step | 12x to 20x real time on desktop | LGPL-3.0 | Active in 2025 | Viable technically; no browser package, LGPL |
| SwiftF0 | Highest pitch F1 in its author's benchmark [BENCH] | 64 ms window plus 176 ms lookahead when streaming | 16x real time with 20 ms chunks on a laptop core | MIT | Active, v0.3.0 in 2026-09 | Fallback if classical detection fails in noise; delay must be accepted |

## What a prototype should settle

These are the claims this research could not source and a decision may lean on:

1. Per-frame cost of MPM at 2048 samples on a real mid-range Android phone and an iPhone, inside an `AudioWorklet` or a worker.
2. How often MPM and USDX-style CAMDF agree on the semitone (octave-folded) for real singing over a backing track through a phone microphone.
3. Whether the clarity threshold alone separates singing from music bleed, or whether a volume gate like USDX's is also needed.

## Sources

Papers:

- [YIN] A. de Cheveigné, H. Kawahara, "YIN, a fundamental frequency estimator for speech and music", J. Acoust. Soc. Am. 111(4), 2002. DOI 10.1121/1.1458024. Read from <https://cagnazzo.wp.imt.fr/files/2013/05/2002_JASA_YIN.pdf>.
- [MPM] P. McLeod, G. Wyvill, "A Smarter Way to Find Pitch", Proc. ICMC 2005, pp. 138-141. Read from the Wayback Machine copy of <http://miracle.otago.ac.nz/tartini/papers/A_Smarter_Way_to_Find_Pitch.pdf>.
- [PYIN] M. Mauch, S. Dixon, "pYIN: A fundamental frequency estimator using probabilistic threshold distributions", ICASSP 2014. DOI 10.1109/ICASSP.2014.6853678. Read from the Wayback Machine copy of <https://www.eecs.qmul.ac.uk/~simond/pub/2014/MauchDixon-PYIN-ICASSP2014.pdf>.
- [CREPE] J. W. Kim, J. Salamon, P. Li, J. P. Bello, "CREPE: A Convolutional Representation for Pitch Estimation", ICASSP 2018. <https://arxiv.org/abs/1802.06182>
- [SPICE] B. Gfeller et al., "SPICE: Self-supervised Pitch Estimation", 2019. <https://arxiv.org/abs/1910.11664>
- [PESTO] A. Riou, S. Lattner, G. Hadjeres, G. Peeters, "PESTO: Pitch Estimation with Self-supervised Transposition-equivariant Objective", ISMIR 2023. <https://arxiv.org/abs/2309.02265>
- [SWIFT] L. Nieradzik, "SwiftF0: Fast and Accurate Monophonic Pitch Detection", preprint, 2025. <https://arxiv.org/abs/2508.18440>. Describes version 0.1.x; the shipped model has since been replaced by a smaller one [SWIFT-README].
- [RIN] C.-Y. Yu, C.-J. Peng, L. Su, G. Fazekas, "Pitch Smoothing Using Relative Interval Networks", preprint, 2026. <https://arxiv.org/abs/2609.39852>

Source code and repositories:

- [USDX-record] UltraStar Deluxe, `src/base/URecord.pas` at commit `e06b7b7`. <https://github.com/UltraStar-Deluxe/USDX/blob/e06b7b7ceff13612f6c5f716b4acedadd4a5f141/src/base/URecord.pas>
- [USDX-note] UltraStar Deluxe, `src/base/UNote.pas`, procedure `NewNote`, same commit. <https://github.com/UltraStar-Deluxe/USDX/blob/e06b7b7ceff13612f6c5f716b4acedadd4a5f141/src/base/UNote.pas>
- [USDX-ini] UltraStar Deluxe, `src/base/UIni.pas` (`IThresholdVals`, `IDifficulty`), same commit. <https://github.com/UltraStar-Deluxe/USDX/blob/e06b7b7ceff13612f6c5f716b4acedadd4a5f141/src/base/UIni.pas>
- [ALLKARAOKE] AllKaraoke, `src/modules/game-engine/input/mic-input.tsx` and `mic-strategies/` at commit `213a42b`. <https://github.com/Asvarox/allkaraoke/tree/213a42b529b92d46ad49e65e785d1d6eba39121b/src/modules/game-engine/input>
- [PITCHY] <https://github.com/ianprime0509/pitchy>
- [PITCHFINDER] <https://github.com/peterkhayes/pitchfinder>
- [AUBIOJS] <https://github.com/qiuxiang/aubiojs>
- [AUBIO] <https://github.com/aubio/aubio>, `src/pitch/pitch.c` for the method list and default.
- [ALESGENOVA] <https://github.com/alesgenova/pitch-detection>
- [SEVAGH] <https://github.com/sevagh/pitch-detection>
- [PITCHLITE] <https://github.com/sevagh/pitchlite>
- [ESSENTIA] <https://github.com/MTG/essentia.js>
- [ML5] <https://github.com/ml5js/ml5-library>, `src/PitchDetection/index.js` and `LICENSE.md`.
- [CREPE-REPO] <https://github.com/marl/crepe>
- [CREPE-WEB] <https://github.com/marl/crepe/tree/gh-pages> (`crepe.js` and `model/`).
- [PYIN-REPO] <https://github.com/c4dm/pyin>
- [PESTO-README] <https://github.com/SonyCSLParis/pesto>
- [SWIFT-README] <https://github.com/lars76/swift-f0> at commit `d1ba77f` (v0.3.0).
- [BENCH] <https://github.com/lars76/pitch-benchmark>, results table in the README. Maintained by the SwiftF0 author.
- [NPM] npm registry and downloads API, <https://registry.npmjs.org/> and <https://api.npmjs.org/downloads/point/last-week/pitchy,pitchfinder,aubiojs>.

Specifications:

- [WEBAUDIO] W3C Web Audio API, render quantum size of 128 frames. <https://www.w3.org/TR/webaudio/>

Not obtained: O. Babacan et al., "A Comparative Study of Pitch Extraction Algorithms on a Large Variety of Singing Sounds", ICASSP 2013. The pYIN paper cites it as showing YIN to be "state of the art" for singing [PYIN, Sec. 1]; I could not read the paper itself, so that is second-hand.
