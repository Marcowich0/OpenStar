# Detector cases

Synthetic cases that pin the live pitch detector (`crates/detector`). Each JSON
file describes one family of signals, how to feed them and the limits every
run must meet. The native build runs them in `cargo test`
(`crates/detector/tests/fixtures.rs`); the WASM build runs the same files
through the worklet code path in Vitest. No audio is stored: both runs generate
the samples from the description below, so they must follow it exactly.

## File format

| Field         | Meaning                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `sampleRates` | Every signal is generated and fed at each of these rates (Hz).                                              |
| `blockLen`    | Frames per audio block fed to the reading maker; the last block may be shorter.                             |
| `waveform`    | `sine`, `sawtooth`, `noise` or `silence`.                                                                   |
| `durationS`   | Length of each signal in seconds: `round(durationS × sampleRate)` frames.                                   |
| `vibrato`     | Optional `{ rateHz, depthCents }` for every signal in the file.                                             |
| `signals`     | One entry per signal: `midi` (tones), `levelDbfs` (all but silence), `seed` (noise), and optional `onsetS`. |
| `limits`      | The checks, below.                                                                                          |

## Generating a signal

All arithmetic is in 64-bit floats; each finished sample is then rounded to a
32-bit float, as an `AudioWorklet` delivers it.

- Frames before the onset frame `n0 = round(onsetS × sampleRate)` (0 without
  `onsetS`) are 0. For frame `n ≥ n0`, `u = (n − n0) / sampleRate`.
- **Level.** `levelDbfs` is the signal's RMS in dBFS, so `rms = 10^(levelDbfs / 20)`
  (a full-scale square wave is 0 dBFS, a full-scale sine −3.01 dBFS).
- **Tones.** `f0 = 440 × 2^((midi − 69) / 12)`. The instantaneous frequency is
  `f(u) = f0 × 2^(depthCents / 1200 × sin(2π × rateHz × u))`, or `f0` without
  vibrato. The phase starts at `φ = 0` at `n0` and advances after each frame:
  `φ(n + 1) = φ(n) + 2π × f(u(n)) / sampleRate`.
  - `sine`: `√2 × rms × sin(φ)`.
  - `sawtooth`, band-limited: `K = floor(0.45 × sampleRate / (f0 × 2^(depthCents / 1200)))`
    harmonics (`depthCents` = 0 without vibrato), sample
    `g × Σ_{k=1..K} sin(k × φ) / k` with `g = rms / √(½ × Σ_{k=1..K} 1 / k²)`.
- **Noise.** White, uniform. A 32-bit xorshift starts at `x = seed`; per frame:
  `x ^= x << 13; x ^= x >> 17; x ^= x << 5` (all modulo 2³²), then
  `v = x / 2³²` and the sample is `√3 × rms × (2v − 1)`.
- **Silence.** Every sample is 0.

## Limits

A reading's window centre is frame `c = endFrame − 1024`; `u(c) = (c − n0) / sampleRate`.

- **Tones** (`medianCentsMax`, `p99CentsMax`). Readings whose whole window lies
  after the onset (`endFrame − 2048 ≥ n0`) are compared with the generated pitch
  at their window centre: `midi + depthCents / 100 × sin(2π × rateHz × u(c))`.
  The error in cents is `100 × |pitch − expected|`; a reading with no pitch
  counts as an infinite error. Per file and sample rate, over all its signals,
  the median error must stay under `medianCentsMax` and the 99th percentile
  (nearest rank) within `p99CentsMax`.
- **Clarity** (`clarityBelow`). Every reading's clarity is below it.
- **Loudness** (`loudnessToleranceDb`). With `p` the fraction of the reading's
  2048-frame window at or after `n0`, the expected loudness is
  `levelDbfs + 10 × log10(p)`, or −120 dBFS for silence and for `p = 0`. Every
  reading with `p = 0` or `p ≥ 0.25` must match within the tolerance; silence
  must read exactly −120. The sawtooth files leave this limit out: a 2048-sample
  window holds under three periods of a low sawtooth, whose squared shape is
  far from even, so the window's own RMS strays from the tone's level by about
  half a decibel. The sine, onset and noise files pin loudness instead.
