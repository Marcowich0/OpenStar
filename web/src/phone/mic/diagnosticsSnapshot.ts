// The Phone mic diagnostics as one JSON object: what the view shows, and
// what "Copy" puts on the clipboard so it can be pasted back from a real
// Phone. Pure: from the mic's measurements now, this Phone's Mic settings and
// the user agent.
//
// The latency is split into the steps from a sung sound to the Stage
// scoring it:
//
// 1. mic → browser input: not measurable on the Phone (no browser reports an
//    input latency); it sits inside the Mic delay, which Calibration measures
//    from the Stage's own tones.
// 2. half the detector window: a reading is stamped at its window's centre,
//    but exists only once the window is full (1024 frames).
// 3. the audio callback and the worklet's queue: how much longer than the
//    quickest reading each waited for the main thread.
// 4. the detector's own cost per window (inside 3, shown on its own).
// 5. the WebSocket and the server's relay: capture to Stage arrival as the
//    Stage measured it, less 2 and 3.
// 6. the Stage's buffering: none (a reading is placed on Song time as it
//    arrives), then the next frame draws it.
// 7. the Mic delay: readings are placed this much earlier on Song time; a
//    Beat is scored once its end plus the Mic delay plus the 300 ms grace
//    period have passed, so a reading must reach the Stage within 300 ms.

import type { StageMicReport } from "../../generated/StageMicReport";
import type { MicSettings } from "../../mics/micSettings";
import type { CaptureInfo } from "../../pitch/capture/capturePipeline";
import type { DetectorCost } from "../../pitch/capture/diagnostics";
import type {
  FrameStatsSummary,
  MicProcessing,
} from "../../pitch/capture/micDiagnostics";
import { SCORING } from "../../scoring/constants";
import type { PhoneMicDiagnostics } from "./phoneMic";

/** Half the detector's 2048-frame window. */
const HALF_WINDOW_FRAMES = 1024;

/** Rounds to a tenth (ms, dB) so the copied JSON stays short. */
function tenth(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Math.round(value * 10) / 10;
}

function share(value: number | null | undefined): number | null {
  return value === null || value === undefined
    ? null
    : Math.round(value * 1000) / 1000;
}

export interface LatencySplit {
  /** Step 2, ms. */
  halfWindowMs: number | null;
  /** Step 3, ms. */
  workletWaitP50Ms: number | null;
  workletWaitP95Ms: number | null;
  /** Step 4, ms. */
  detectorP50Ms: number | null;
  detectorP95Ms: number | null;
  /** Capture (window centre) → Stage arrival, as the Stage measured it. */
  captureToStageP50Ms: number | null;
  captureToStageP95Ms: number | null;
  captureToStageMaxMs: number | null;
  /** Step 5 at the median: arrival less steps 2 and 3. */
  networkAndRelayP50Ms: number | null;
  /** Half the best clock round trip: the quickest one-way trip. */
  bestOneWayMs: number | null;
  /** The longest the Stage waited between two readings, ms. */
  largestGapMs: number | null;
  /** Share of readings that took longer than the grace period. */
  lateShare: number | null;
  /** Step 6: the next frame, at most this, ms. */
  stageFrameMs: number;
  /** Step 7. */
  micDelayMs: number;
  gracePeriodMs: number;
  /** From a Beat's end until it is scored. */
  scoredAfterBeatEndMs: number;
}

export interface DiagnosticsSnapshot {
  takenAt: string;
  userAgent: string;
  state: PhoneMicDiagnostics["state"];
  processing: MicProcessing;
  audio: {
    sampleRate: number | null;
    baseLatencyMs: number | null;
    outputLatencyMs: number | null;
  };
  /** What the mic was asked for and what the browser applied. */
  constraints: MediaStreamConstraints["audio"] | null;
  trackSettings: MediaTrackSettings | null;
  track: {
    label: string | null;
    muted: boolean | null;
    readyState: string | null;
  };
  wakeLock: boolean;
  hidden: boolean;
  threshold: {
    effectiveDbfs: number;
    source: MicSettings["thresholdSource"];
    calibrated: boolean;
    /** What the Stage would use now, from its own copy. */
    stageDbfs: number | null;
  };
  level: {
    nowDbfs: number | null;
    p50Dbfs: number | null;
    p95Dbfs: number | null;
  };
  /** Shares of the last 2 s of readings, by the scorer's rules. */
  frames: {
    gated: number | null;
    unvoiced: number | null;
    voiced: number | null;
  };
  pitch: { midi: number | null; clarity: number | null };
  rates: {
    madePerSecond: number;
    sentPerSecond: number;
    stageReceivedPerSecond: number | null;
  };
  clock: {
    offsetMs: number | null;
    bestRoundTripMs: number | null;
    roundTripP50Ms: number | null;
    roundTripP95Ms: number | null;
  };
  latency: LatencySplit;
  stageReportAgeMs: number | null;
}

/** At most this long since the Stage answered, or its report counts as gone. */
export const STAGE_REPORT_FRESH_MS = 3000;

export function diagnosticsSnapshot(
  diagnostics: PhoneMicDiagnostics,
  settings: MicSettings,
  userAgent: string,
): DiagnosticsSnapshot {
  const { capture, frames, detector } = diagnostics;
  const stage = freshStage(diagnostics);
  return {
    takenAt: diagnostics.takenAt,
    userAgent,
    state: diagnostics.state,
    processing: diagnostics.processing,
    audio: {
      sampleRate: capture?.sampleRate ?? null,
      baseLatencyMs: tenth(capture?.baseLatencyMs),
      outputLatencyMs: tenth(capture?.outputLatencyMs),
    },
    constraints: capture?.requested.audio ?? null,
    trackSettings: capture?.settings ?? null,
    track: {
      label: capture?.label ?? null,
      muted: capture?.muted ?? null,
      readyState: capture?.readyState ?? null,
    },
    wakeLock: diagnostics.wakeLock,
    hidden: diagnostics.hidden,
    threshold: {
      effectiveDbfs: tenth(settings.effectiveThresholdDbfs) ?? 0,
      source: settings.thresholdSource,
      calibrated: settings.calibrated,
      stageDbfs: tenth(stage?.micThresholdDbfs),
    },
    level: {
      nowDbfs: tenth(frames.levelDbfs),
      p50Dbfs: tenth(frames.level.p50),
      p95Dbfs: tenth(frames.level.p95),
    },
    frames: {
      gated: share(frames.shares?.gated),
      unvoiced: share(frames.shares?.unvoiced),
      voiced: share(frames.shares?.voiced),
    },
    pitch: {
      midi: tenth(frames.pitch),
      clarity: share(frames.clarity),
    },
    rates: {
      madePerSecond: frames.madePerSecond,
      sentPerSecond: frames.sentPerSecond,
      stageReceivedPerSecond: stage?.receivedPerSecond ?? null,
    },
    clock: {
      offsetMs: tenth(diagnostics.clockOffsetMs),
      bestRoundTripMs: tenth(bestRoundTrip(frames)),
      roundTripP50Ms: tenth(frames.roundTripMs.p50),
      roundTripP95Ms: tenth(frames.roundTripMs.p95),
    },
    latency: latencySplit(capture, frames, detector, stage, settings),
    stageReportAgeMs: tenth(diagnostics.stageReportAgeMs),
  };
}

function freshStage(d: PhoneMicDiagnostics): StageMicReport | null {
  return d.stage !== null &&
    d.stageReportAgeMs !== null &&
    d.stageReportAgeMs <= STAGE_REPORT_FRESH_MS
    ? d.stage
    : null;
}

/** The quickest round trip of the window (the one sync trusts). */
function bestRoundTrip(frames: FrameStatsSummary): number | null {
  return frames.roundTripMinMs;
}

function latencySplit(
  capture: CaptureInfo | null,
  frames: FrameStatsSummary,
  detector: DetectorCost | null,
  stage: StageMicReport | null,
  settings: MicSettings,
): LatencySplit {
  const halfWindowMs = capture
    ? (HALF_WINDOW_FRAMES / capture.sampleRate) * 1000
    : null;
  const waitP50 = frames.workletWaitMs.p50;
  const arrivalP50 = stage?.arrivalP50Ms ?? null;
  const network =
    arrivalP50 !== null && halfWindowMs !== null
      ? Math.max(0, arrivalP50 - halfWindowMs - (waitP50 ?? 0))
      : null;
  const micDelayMs = stage?.micDelayMs ?? settings.micDelayMs;
  const best = bestRoundTrip(frames);
  return {
    halfWindowMs: tenth(halfWindowMs),
    workletWaitP50Ms: tenth(waitP50),
    workletWaitP95Ms: tenth(frames.workletWaitMs.p95),
    detectorP50Ms: tenth(detector?.p50Ms),
    detectorP95Ms: tenth(detector?.p95Ms),
    captureToStageP50Ms: tenth(arrivalP50),
    captureToStageP95Ms: tenth(stage?.arrivalP95Ms),
    captureToStageMaxMs: tenth(stage?.arrivalMaxMs),
    networkAndRelayP50Ms: tenth(network),
    bestOneWayMs: tenth(best === null ? null : best / 2),
    largestGapMs: tenth(stage?.largestGapMs),
    lateShare: share(stage?.lateShare),
    stageFrameMs: 16.7,
    micDelayMs: tenth(micDelayMs) ?? 0,
    gracePeriodMs: SCORING.gracePeriodMs,
    scoredAfterBeatEndMs:
      tenth(Math.max(0, micDelayMs) + SCORING.gracePeriodMs) ?? 0,
  };
}
