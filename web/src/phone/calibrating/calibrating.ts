// The Phone's Calibrating takeover (v1 spec #52, "Getting ready" and "The
// run"; ticket #173): a pure function of the live store and this Phone's
// mic. From Continue through the tones of a Calibration run that names this
// Phone, the Phone page is the takeover, in this Phone's own Party colour,
// above the Remote and the mic takeover (`phonePage`). On the checklist and
// once the results show it is not: the Phone returns to what it showed
// before, and the Remote's Stage tab shows the result rows (#174).
//
// Steps: `listen` (the big "I'm listening" tap), `opening`, `ready` (the
// server has heard "I'm listening" while the mic is on), `blocked` (the mic
// did not open: the reason and Try again), `tones` (the run's progress and
// "stay quiet"). A Phone not ready by Go is left out of the tones, so its
// takeover closes when they start.

import type { PaletteKey } from "../../generated/PaletteKey";
import type { PhoneId } from "../../generated/PhoneId";
import { LISTEN_AFTER_TONES_MS } from "../../calibration/stageCalibration";
import type { LiveState } from "../../live/liveState";
import { CALIBRATION } from "../../mics/micSettings";
import type {
  MicBlockedReason,
  PhoneMic,
  PhoneMicSnapshot,
} from "../mic/phoneMic";
import { phoneMember } from "../phonePage";

export type CalibratingStep =
  "listen" | "opening" | "ready" | "blocked" | "tones";

export interface Calibrating {
  step: CalibratingStep;
  /** This Phone's Party member's colour, the takeover's background. */
  colour: PaletteKey;
  /** Why the mic could not open, exactly while `blocked`. */
  blocked: MicBlockedReason | null;
}

/** This Phone's entry in a run waiting for its Mics or playing its tones. */
function myEntry(state: LiveState, phoneId: PhoneId) {
  const run = state.calibration;
  if (run?.phase !== "waiting" && run?.phase !== "tones") return null;
  const entry = run.mics.find(
    (m) => m.mic.kind === "phone" && m.mic.phoneId === phoneId,
  );
  return entry ? { phase: run.phase, ready: entry.ready } : null;
}

/** Whether the Phone `phoneId` shows the Calibrating takeover. */
export function isCalibrating(state: LiveState, phoneId: PhoneId): boolean {
  return myEntry(state, phoneId) !== null;
}

export function calibrating(
  state: LiveState,
  phoneId: PhoneId,
  mic: Pick<PhoneMicSnapshot, "state" | "blocked">,
): Calibrating | null {
  const entry = myEntry(state, phoneId);
  const member = phoneMember(state);
  if (!entry || !member) return null;
  return {
    step:
      entry.phase === "tones" ? "tones" : waitingStep(entry.ready, mic.state),
    colour: member.colour,
    blocked: mic.state === "failed" ? mic.blocked : null,
  };
}

function waitingStep(
  ready: boolean,
  mic: PhoneMicSnapshot["state"],
): CalibratingStep {
  switch (mic) {
    case "opening":
      return "opening";
    case "failed":
      return "blocked";
    case "on":
      return ready ? "ready" : "listen";
    case "off":
    case "lost":
      return "listen";
  }
}

/**
 * "I'm listening": opens the mic exactly as for singing (the same
 * `PhoneMic`, so the same constraints, capture clock and relay), then tells
 * the server this Mic is ready. A mic already on (a seated Phone) says so at
 * once. Returns a cancel for a tap whose mic has not opened yet.
 */
export function imListening(
  mic: Pick<PhoneMic, "getSnapshot" | "subscribe" | "turnOn" | "singAgain">,
  send: (message: { type: "calibrationListening" }) => void,
): () => void {
  const state = mic.getSnapshot().state;
  if (state === "on") {
    send({ type: "calibrationListening" });
    return () => {};
  }
  const unsubscribe = mic.subscribe(() => {
    const next = mic.getSnapshot().state;
    if (next === "opening") return;
    unsubscribe();
    if (next === "on") send({ type: "calibrationListening" });
  });
  if (state === "lost") mic.singAgain();
  else mic.turnOn();
  return unsubscribe;
}

/** From the first tone's start to the end of the Stage's listening after the last. */
export const TONES_RUN_MS =
  (CALIBRATION.toneCount - 1) * CALIBRATION.toneOnsetSpacingMs +
  CALIBRATION.toneDurationMs +
  LISTEN_AFTER_TONES_MS;

/** The tones' progress, 0 to 1, this long after the Phone saw them start. */
export function tonesProgress(elapsedMs: number): number {
  return Math.min(1, Math.max(0, elapsedMs / TONES_RUN_MS));
}
