import { useSyncExternalStore } from "react";

import type { PhoneId } from "../../generated/PhoneId";
import type { LiveStore } from "../../live/liveStore";
import { useLiveState } from "../../live/useLive";
import type { PhoneMic } from "../mic/phoneMic";
import { micTakeover, type MicTakeover } from "./micTakeover";

/** The mic takeover, or `null` while this Phone is no seat's Mic. */
export function useMicTakeover(
  store: LiveStore,
  phoneId: PhoneId,
  mic: PhoneMic,
): MicTakeover | null {
  const state = useLiveState(store);
  const snapshot = useSyncExternalStore(mic.subscribe, mic.getSnapshot);
  return micTakeover(state, phoneId, snapshot);
}
