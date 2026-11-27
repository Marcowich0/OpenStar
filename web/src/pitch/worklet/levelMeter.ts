// The loudness of a pitch node's input while its detector is off (v1 spec
// #51: meters run on every open device, detectors only for seated Local mics
// during a Song). The same window, schedule and formula as the detector's
// reading maker (crates/detector `ReadingMaker`, `loudness_dbfs`): the RMS of
// the newest 2048 frames in dBFS, floored at −120, once the window is full
// and then once per 10 ms hop, checked at the end of each block. Bundled into
// the worklet file.

/** The detector's window, frames (`WINDOW_LEN`). */
const WINDOW_LEN = 2048;
/** The loudness of digital silence, and the floor (`SILENCE_DBFS`). */
const SILENCE_DBFS = -120;

export interface LevelMeter {
  /** Feeds one block; the loudness at its end, if a level was due. */
  push: (block: Float32Array) => number | null;
  /**
   * Whether the window is exact digital silence: its 2048 newest frames all
   * exactly 0 (v1 spec #51, "sends no sound"). Quiet noise is not, however
   * far below the −120 floor it reads.
   */
  zero: () => boolean;
}

export function createLevelMeter(sampleRate: number): LevelMeter {
  const hop = Math.round(sampleRate * 0.01);
  const ring = new Float32Array(WINDOW_LEN);
  let next = 0;
  let frames = 0;
  let lastLevelEnd: number | null = null;
  /** Exact zeros since the newest non-zero sample, up to the window. */
  let zeros = 0;

  return {
    push(block) {
      const keep = block.subarray(Math.max(0, block.length - WINDOW_LEN));
      for (const sample of keep) {
        ring[next] = sample;
        next = (next + 1) % WINDOW_LEN;
      }
      for (const sample of block) {
        if (sample === 0) zeros = Math.min(WINDOW_LEN, zeros + 1);
        else zeros = 0;
      }
      frames += block.length;
      if (frames < WINDOW_LEN) return null;
      if (lastLevelEnd !== null && frames - lastLevelEnd < hop) return null;
      lastLevelEnd = frames;
      let sumSq = 0;
      for (const sample of ring) sumSq += sample * sample;
      const meanSq = sumSq / WINDOW_LEN;
      if (meanSq <= 0) return SILENCE_DBFS;
      return Math.max(SILENCE_DBFS, 10 * Math.log10(meanSq));
    },
    zero: () => zeros >= WINDOW_LEN,
  };
}
