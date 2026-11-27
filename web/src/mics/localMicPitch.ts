// Pitch readings from the Stage browser's own Local mics (v1 spec #51,
// ticket #130). A channel's detector runs only while its Local mic is seated
// in the Song that plays or takes part in a Calibration run (#210); its meter runs
// whenever its device is open. Its readings, stamped on this page's
// `performance.now()` with offset 0 (`localMicCapture.ts`), go straight into
// the Stage's Pitch router under the Local mic's id: no relay, no clock sync.

import type { CalibrationRun } from "../generated/CalibrationRun";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { PitchRouter } from "../pitch/pitchRouter";
import type { CaptureChannel, LocalMicCapture } from "./localMicCapture";
import { browserLocalMicId } from "./localMics";

/**
 * The Local mic ids whose detectors run: every switched-on Local mic seated
 * in the Line-up of the Song that plays, and every Local mic of a
 * Calibration run while it waits or plays its tones, seated or not (#210).
 * A paused Song still plays: its Mics keep sending, or the lost-Mic rule
 * would take a pause for a lost Mic. The server's `detecting_local_mics`
 * (`live/bridges.rs`) is the same rule for the Mic bridges.
 */
export function detectingLocalMics(
  party: PartySnapshot | null,
  calibration: CalibrationRun | null = null,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (calibration?.phase === "waiting" || calibration?.phase === "tones") {
    for (const { mic } of calibration.mics)
      if (mic.kind === "localMic") ids.add(mic.localMicId);
  }
  if (!party?.playing || !party.lineUp) return ids;
  const switchedOn = new Set(party.localMics.map((m) => m.localMicId));
  for (const { mic } of party.lineUp.seats) {
    if (mic?.kind === "localMic" && switchedOn.has(mic.localMicId))
      ids.add(mic.localMicId);
  }
  return ids;
}

/** The open channels of this Stage browser whose Local mic is in `detecting`. */
export function detectingChannels({
  stageBrowser,
  open,
  detecting,
}: {
  stageBrowser: string;
  /** Open devices and their channel counts (`CaptureSnapshot.open`). */
  open: ReadonlyMap<string, number>;
  detecting: ReadonlySet<string>;
}): CaptureChannel[] {
  const channels: CaptureChannel[] = [];
  for (const [deviceId, count] of open) {
    for (let channel = 0; channel < count; channel++) {
      if (detecting.has(browserLocalMicId(stageBrowser, deviceId, channel)))
        channels.push({ deviceId, channel });
    }
  }
  return channels;
}

/**
 * Hands every reading of `capture` to `router` as its Local mic's. Returns
 * the unsubscribe.
 */
export function routeLocalMicReadings(
  capture: LocalMicCapture,
  stageBrowser: string,
  router: Pick<PitchRouter, "receive">,
): () => void {
  return capture.subscribeReadings((deviceId, channel, reading) => {
    router.receive(
      {
        kind: "localMic",
        localMicId: browserLocalMicId(stageBrowser, deviceId, channel),
      },
      reading,
    );
  });
}
