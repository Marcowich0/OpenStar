import { useEffect, useState } from "react";

import type { LiveStore } from "../live/liveStore";
import {
  TOAST_LEAVE_MS,
  TOAST_STAY_MS,
  toastPhase,
  type ToastPhase,
} from "./toastQueue";

const PHASE_CHANGES = [TOAST_STAY_MS, TOAST_STAY_MS + TOAST_LEAVE_MS];

/**
 * A shown toast's phase, moved on by its own timers from the moment it
 * mounts; at "gone" it is dropped from the live store. The Stage's and the
 * Phone's toasts share it.
 */
export function useToastPhase(id: number, store: LiveStore): ToastPhase {
  // Its age since it appeared, moved on at each change of phase.
  const [age, setAge] = useState(0);
  useEffect(() => {
    const timers = PHASE_CHANGES.map((at) =>
      setTimeout(() => {
        setAge(at);
      }, at),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);
  const phase = toastPhase(age);
  useEffect(() => {
    if (phase === "gone") store.dismissToast(id);
  }, [phase, id, store]);
  return phase;
}
