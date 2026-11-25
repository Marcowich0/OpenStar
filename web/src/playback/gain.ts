/**
 * The two gains of the Stage's chain (#53, "The gain chain and Song
 * loudness"): the Song gain brings every Song to one loudness target, the
 * OpenStar volume sets how loud the room hears it. Both are pure.
 */

export const SONG_LOUDNESS = {
  /** Every Song plays at this integrated loudness, LUFS. */
  targetLufs: -18,
  /** A quiet Song is raised by at most this much, dB, so it never clips. */
  maxBoostDb: 6,
} as const;

/**
 * One OpenStar volume per Stage output: 0 to 100 in steps of 5. The server
 * steps and stores it (`crates/protocol/src/volume.rs`, kept equal by
 * `checks/openstarVolume.test.ts`).
 */
export const OPENSTAR_VOLUME = {
  min: 0,
  max: 100,
  step: 5,
  /** Where an output with no stored volume starts. */
  default: 80,
} as const;

/**
 * The Song gain in dB for a Song measured at `lufs` (EBU R128 integrated
 * loudness): `min(−18 − lufs, +6)`. A Song not measured yet (`null`) plays at
 * unity, 0 dB.
 */
export function songGainDb(lufs: number | null): number {
  if (lufs === null || !Number.isFinite(lufs)) return 0;
  return Math.min(SONG_LOUDNESS.targetLufs - lufs, SONG_LOUDNESS.maxBoostDb);
}

/** A level in dB as a linear gain. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** The OpenStar volume `volume` (0–100) as a linear gain, `(v/100)²`. */
export function volumeGain(volume: number): number {
  const v =
    Math.min(Math.max(volume, OPENSTAR_VOLUME.min), OPENSTAR_VOLUME.max) / 100;
  return v * v;
}
