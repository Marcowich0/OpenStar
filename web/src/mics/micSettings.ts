/**
 * Mic settings: every Calibration and Mic threshold constant, and the one
 * function that turns what is stored for a Mic at the current Stage output
 * into the Mic delay and effective Mic threshold to use (v1 spec #52).
 *
 * Every stored dBFS value, and every dBFS constant here, is at the reference
 * volume; the effective Mic threshold adds the OpenStar volume's level.
 */

import type { MicKind } from "../generated/MicKind";
import type { StoredMicSettings } from "../generated/StoredMicSettings";
import type { ThresholdSetBy } from "../generated/ThresholdSetBy";

/** Mic threshold rules. Every dBFS value is at the reference volume. */
export const MIC_THRESHOLD = {
  /** Calibration sets a Mic threshold to its bleed level + this margin. */
  bleedMarginDb: 6,
  /**
   * A Phone's Mic threshold when never calibrated nor set by hand. Kept at
   * −30: the recorded Phone runs (`fixtures/readings/`) put Bleed at up to
   * about −33 dBFS on the one Phone measured, so a lower fixed value lets
   * Bleed score (−32 already breaks the 4 % limit), while singing on that
   * Phone sits around −22 to −34. No one fixed value fits every Phone and
   * room: Calibration or a hand setting with the Phone's meter does.
   */
  phoneFallbackDbfs: -30,
  /** A Local mic's Mic threshold when never calibrated nor set by hand. */
  localMicDefaultDbfs: -40,
  /** The OpenStar volume (0 to 100) at which a volume's level is 0 dB. */
  referenceVolume: 80,
} as const;

/** Default Mic delays for a Mic not calibrated at the current Stage output. */
export const MIC_DELAY = {
  /** Measured on Android with echo cancellation on. */
  phoneDefaultMs: 100,
} as const;

/** The Calibration run and the rules for reading its results. */
export const CALIBRATION = {
  toneCount: 8,
  toneDurationMs: 200,
  /** A4. */
  toneFrequencyHz: 440,
  /** From one tone's start to the next ("about 600 ms apart"). */
  toneOnsetSpacingMs: 600,
  /** The Song loudness target (EBU R128 integrated loudness). */
  toneLoudnessLufs: -18,
  /** A reading counts for a tone from this long before its reported output time… */
  readingWindowStartMs: -150,
  /** …to this long after it. */
  readingWindowEndMs: 700,
  /**
   * A counting reading starts a tone only after this long without one. The
   * tones are 400 ms apart, so a tone heard late, whose end runs into the next
   * tone's window, is never taken for the next tone's start: Mic delays up to
   * about 450 ms (a Phone through a TV, soundbar or Bluetooth) still calibrate.
   */
  onsetSilenceMs: 200,
  /** Within this many cents of A4, octave folded. */
  pitchToleranceCents: 50,
  minClarity: 0.8,
  /** A Mic that heard fewer tones fails. */
  minTonesHeard: 5,
  /** A Mic whose per-tone delays spread more than this fails. */
  maxDelayStandardDeviationMs: 25,
  /** The bleed level is this percentile of loudness during the tones. */
  bleedLevelPercentile: 95,
} as const;

/** Volume 0 uses this volume's level, so no threshold is ever −∞. */
const SILENT_VOLUME_STAND_IN = 5;

/** What a Player sang into (generated from Rust). */
export type { MicKind };

/** What the server keeps for one Mic at one Stage output (generated from Rust). */
export type { StoredMicSettings, ThresholdSetBy };

/** Where an effective Mic threshold came from. */
export type ThresholdSource = ThresholdSetBy | "default";

export interface MicSettingsInput {
  kind: MicKind;
  /** What is stored for this Mic at the current Stage output, if anything. */
  stored: StoredMicSettings | undefined;
  /** A Local mic's reported input delay, if any; ignored for a Phone. */
  reportedInputDelayMs?: number | null | undefined;
  /** The OpenStar volume, 0 to 100. */
  volume: number;
}

export interface MicSettings {
  micDelayMs: number;
  effectiveThresholdDbfs: number;
  calibrated: boolean;
  thresholdSource: ThresholdSource;
}

/** The OpenStar volume's level in dB relative to the reference volume. */
export function volumeLevelDb(volume: number): number {
  const v = volume <= 0 ? SILENT_VOLUME_STAND_IN : volume;
  return 40 * Math.log10(v / MIC_THRESHOLD.referenceVolume);
}

/**
 * Converts a value at some OpenStar volume (an effective threshold shown on a
 * meter, or a bleed level measured during Calibration) to the reference
 * volume, where it is stored.
 */
export function atReferenceVolume(dbfs: number, volume: number): number {
  return dbfs - volumeLevelDb(volume);
}

/** The values stored for a Mic at one Stage output, if any. */
export function storedAtStageOutput(
  byStageOutput: Readonly<Record<string, StoredMicSettings>>,
  stageOutput: string,
): StoredMicSettings | undefined {
  return Object.hasOwn(byStageOutput, stageOutput)
    ? byStageOutput[stageOutput]
    : undefined;
}

/**
 * The Mic delay and effective Mic threshold for a Mic at the current Stage
 * output and OpenStar volume. The scorer's threshold at Start and every
 * meter's threshold line use this, so they always agree.
 */
export function resolveMicSettings(input: MicSettingsInput): MicSettings {
  const calibration = input.stored?.calibration;
  const level = volumeLevelDb(input.volume);

  if (input.kind === "localMic") {
    const threshold = input.stored?.micThreshold;
    return {
      micDelayMs: calibration
        ? calibration.micDelayMs
        : (input.reportedInputDelayMs ?? 0),
      effectiveThresholdDbfs:
        (threshold?.referenceDbfs ?? MIC_THRESHOLD.localMicDefaultDbfs) + level,
      calibrated: calibration !== undefined,
      thresholdSource: threshold?.setBy ?? "default",
    };
  }

  // A Phone: a stored Mic threshold (by hand, or by a Calibration run since
  // Phones store one too) wins, last write wins. A Phone calibrated before
  // Calibration stored its threshold has only its bleed level: + 6 dB.
  const threshold = input.stored?.micThreshold;
  const micDelayMs = calibration
    ? calibration.micDelayMs
    : MIC_DELAY.phoneDefaultMs;
  if (threshold) {
    return {
      micDelayMs,
      effectiveThresholdDbfs: threshold.referenceDbfs + level,
      calibrated: calibration !== undefined,
      thresholdSource: threshold.setBy,
    };
  }
  if (calibration) {
    return {
      micDelayMs,
      effectiveThresholdDbfs:
        calibration.bleedLevelDbfs + MIC_THRESHOLD.bleedMarginDb + level,
      calibrated: true,
      thresholdSource: "calibration",
    };
  }
  return {
    micDelayMs,
    effectiveThresholdDbfs: MIC_THRESHOLD.phoneFallbackDbfs + level,
    calibrated: false,
    thresholdSource: "default",
  };
}
