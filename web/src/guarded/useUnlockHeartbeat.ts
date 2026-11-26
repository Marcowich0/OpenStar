// The Unlock heartbeat (v1 spec #45): while an Admin area screen is visible,
// the browser sends `POST /api/unlock/heartbeat` every 60 s, and each one
// resets the Unlock's 30-minute idle time on the server. A hidden tab sends
// none, so an Unlock left in a background tab still runs out.
//
// The heartbeat never creates or revives an Unlock: the server answers
// `401 unlockRequired` once it is gone (idle expiry, Lock in another tab),
// and the Lock button goes away.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { api } from "../api/api";
import { unlockQuery } from "../api/queries";
import { isUnlockRequired, setUnlocked, useUnlocked } from "./unlock";

export const HEARTBEAT_MS = 60_000;

export function useUnlockHeartbeat() {
  const queryClient = useQueryClient();
  const unlocked = useUnlocked();

  useEffect(() => {
    if (!unlocked) return;
    const beat = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      api("POST /api/unlock/heartbeat").then(
        (status) => {
          setUnlocked(queryClient, status.unlocked);
        },
        (error: unknown) => {
          if (isUnlockRequired(error)) setUnlocked(queryClient, false);
        },
      );
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(beat);
    };
  }, [unlocked, queryClient]);

  // Back from a hidden tab: the Unlock may have ended (or begun) meanwhile.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible")
        void queryClient.invalidateQueries(unlockQuery);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [queryClient]);
}
