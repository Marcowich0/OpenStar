// The browser's Phone mic: one per live store, on the real devices, with the
// page's visibility and the screen Wake Lock, following the Line-up, and
// resyncing after each reconnect.

import type { LiveStore } from "../../live/liveStore";
import { loadCaptureClock } from "../../pitch/clock/senderSession";
import { measureDetectorCost } from "../../pitch/capture/diagnostics";
import {
  createPitchNode,
  detectorWasm,
} from "../../pitch/worklet/pitchWorklet";
import type { PhoneId } from "../../generated/PhoneId";
import { onReconnect } from "./reconnect";
import { followLineUp } from "./micLineUp";
import {
  createPhoneMic,
  MediaDevicesMissingError,
  type PageVisibility,
  type PhoneMic,
  type WakeLockHold,
} from "./phoneMic";

const mics = new WeakMap<LiveStore, PhoneMic>();

/** The sample rate the detector's cost is measured at. */
const COST_SAMPLE_RATE = 48000;

function getUserMedia(constraints: MediaStreamConstraints) {
  // `navigator.mediaDevices` exists only on HTTPS (or localhost).
  if (typeof navigator === "undefined" || !("mediaDevices" in navigator))
    return Promise.reject(new MediaDevicesMissingError());
  return navigator.mediaDevices.getUserMedia(constraints);
}

const documentPage: PageVisibility = {
  hidden: () => document.visibilityState === "hidden",
  onChange(listener) {
    // `pagehide` too: a page going into the back/forward cache or being
    // closed tells the Stage while it still can.
    document.addEventListener("visibilitychange", listener);
    window.addEventListener("pagehide", listener);
    return () => {
      document.removeEventListener("visibilitychange", listener);
      window.removeEventListener("pagehide", listener);
    };
  },
};

function requestWakeLock(): Promise<WakeLockHold> {
  // Missing before Chrome 84 and Safari 16.4: the mic works without it.
  if (!("wakeLock" in navigator))
    return Promise.reject(new Error("navigator.wakeLock is missing"));
  return navigator.wakeLock.request("screen");
}

export function phoneMicFor(store: LiveStore, phoneId: PhoneId): PhoneMic {
  let mic = mics.get(store);
  if (!mic) {
    mic = createPhoneMic({
      store: {
        send: store.send,
        onClockPong: store.onClockPong,
        onReconnect: (listener) => onReconnect(store, listener),
      },
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
      page: documentPage,
      wakeLock: requestWakeLock,
    });
    followLineUp(store, phoneId, mic);
    mics.set(store, mic);
  }
  return mic;
}
