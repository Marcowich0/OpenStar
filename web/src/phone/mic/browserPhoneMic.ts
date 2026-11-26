// The browser's Phone mic: one per live store, on the real devices.

import type { LiveStore } from "../../live/liveStore";
import { loadCaptureClock } from "../../pitch/clock/senderSession";
import { measureDetectorCost } from "../../pitch/capture/diagnostics";
import {
  createPitchNode,
  detectorWasm,
} from "../../pitch/worklet/pitchWorklet";
import { createPhoneMic, type PhoneMic } from "./phoneMic";

const mics = new WeakMap<LiveStore, PhoneMic>();

/** The sample rate the detector's cost is measured at. */
const COST_SAMPLE_RATE = 48000;

function getUserMedia(constraints: MediaStreamConstraints) {
  // `navigator.mediaDevices` exists only on HTTPS (or localhost).
  if (typeof navigator === "undefined" || !("mediaDevices" in navigator))
    return Promise.reject(new Error("navigator.mediaDevices is missing"));
  return navigator.mediaDevices.getUserMedia(constraints);
}

export function phoneMicFor(store: LiveStore): PhoneMic {
  let mic = mics.get(store);
  if (!mic) {
    mic = createPhoneMic({
      store,
      capture: {
        getUserMedia,
        createContext: () => new AudioContext({ latencyHint: "interactive" }),
        createPitchNode: (context, onReading) =>
          createPitchNode(context as AudioContext, onReading),
        captureClock: loadCaptureClock,
        now: () => performance.now(),
      },
      measureCost: async () =>
        measureDetectorCost({
          module: await WebAssembly.compile(await detectorWasm()),
          sampleRate: COST_SAMPLE_RATE,
        }),
    });
    mics.set(store, mic);
  }
  return mic;
}
