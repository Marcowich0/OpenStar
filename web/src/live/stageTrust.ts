// Stage trust (v1 spec #45): a browser gives the Admin PIN once before it
// may become the Stage, and the server remembers it by its own Stage cookie.
// The Stage's WebSocket (`/ws/stage`) refuses a browser without it, so the
// live client on `/stage` waits for `whenTrusted()` before every connection.
// Stage trust is not an Unlock: giving the PIN here unlocks nothing.
//
// No React here: the live client uses it; `stage/trust/StageTrustGate` shows
// the Admin PIN pad while it says `pinNeeded`.

import { ApiFailure, api } from "../api/api";

/**
 * - `checking`: the server has not answered yet (or could not be reached).
 * - `pinNeeded`: this browser is not a remembered Stage browser; the pad shows.
 * - `trusted`: the server remembers this browser as a Stage browser.
 */
export type StageTrustState = "checking" | "pinNeeded" | "trusted";

export interface StageTrust {
  getSnapshot: () => StageTrustState;
  subscribe: (listener: () => void) => () => void;
  /**
   * Asks the server whether this browser is trusted, and resolves once it is:
   * at once for a remembered browser, after a correct PIN otherwise. When
   * the server cannot be reached it resolves too, so the socket tries (and
   * retries with its backoff).
   */
  whenTrusted: () => Promise<void>;
  /** One Admin PIN attempt; the pad's `check`. Rejects with `ApiFailure`. */
  giveAdminPin: (pin: string) => Promise<void>;
}

export function createStageTrust(): StageTrust {
  let state: StageTrustState = "checking";
  const listeners = new Set<() => void>();
  let waiters: (() => void)[] = [];

  function set(next: StageTrustState) {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  function trusted() {
    set("trusted");
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async whenTrusted() {
      try {
        await api("POST /api/stage/trust", { body: {} });
      } catch (error) {
        if (
          error instanceof ApiFailure &&
          error.failure.kind === "refused" &&
          error.failure.error.code === "stagePinRequired"
        ) {
          set("pinNeeded");
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
        }
        return;
      }
      trusted();
    },
    async giveAdminPin(pin) {
      await api("POST /api/stage/trust", { body: { pin } });
      trusted();
    },
  };
}
