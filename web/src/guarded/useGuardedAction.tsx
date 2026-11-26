// The one guarded-action flow (v1 spec #45), for every guarded button in
// OpenStar: the Admin area's and the Stage's Mics screen's alike.
//
// 1. The action is sent as it is. The server alone checks the Unlock.
// 2. If it refuses with `401 unlockRequired`, the Admin PIN pad opens.
// 3. After a correct PIN the same action is sent once more, and later guarded
//    actions in this browser go straight through until the Unlock ends.
//
// An action marked `writesLibrary` is disabled while the Library is
// read-only, whatever the Unlock; `LibraryReadOnlyNotice` says why.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";

import { serverInfoQuery } from "../api/queries";
import { AdminPinDialog, unlockWithPin } from "../pin/AdminPinDialog";
import { isLibraryReadOnly, isUnlockRequired, setUnlocked } from "./unlock";

/** How a guarded action ended, unless it failed (then `run` rejects). */
export type GuardedOutcome<T> =
  | { kind: "done"; value: T }
  /** The PIN pad was closed without a correct PIN; nothing was done. */
  | { kind: "cancelled" }
  /** It writes the Library, which is read-only; nothing was sent. */
  | { kind: "readOnly" };

export interface GuardedActionOptions {
  /** It changes the Library's files: disabled while the Library is read-only. */
  writesLibrary?: boolean;
}

export interface GuardedAction<T> {
  /**
   * Starts the action, asking for the PIN if the server wants an Unlock.
   * Rejects with the action's own failure for any other refusal.
   */
  run: () => Promise<GuardedOutcome<T>>;
  /** Disabled: it writes the Library and the Library is read-only. */
  isDisabled: boolean;
  /** The Admin PIN pad; render it once, anywhere. */
  dialog: ReactNode;
}

interface Waiting<T> {
  resolve: (outcome: GuardedOutcome<T>) => void;
  reject: (error: unknown) => void;
  pinTaken: boolean;
}

/** Whether the Library is read-only, from `GET /api/server-info`. */
export function useLibraryReadOnly() {
  return useQuery(serverInfoQuery).data?.libraryReadOnly ?? null;
}

export function useGuardedAction<T>(
  action: () => Promise<T>,
  { writesLibrary = false }: GuardedActionOptions = {},
): GuardedAction<T> {
  const queryClient = useQueryClient();
  const readOnly = useLibraryReadOnly();
  const isDisabled = writesLibrary && readOnly !== null;
  const [padOpen, setPadOpen] = useState(false);
  const waiting = useRef<Waiting<T> | null>(null);

  async function send(): Promise<T> {
    try {
      const value = await action();
      // A guarded answer that went through means the Unlock is alive.
      setUnlocked(queryClient, true);
      return value;
    } catch (error) {
      if (isUnlockRequired(error)) setUnlocked(queryClient, false);
      // The Library turned read-only since server-info was read.
      if (isLibraryReadOnly(error))
        void queryClient.invalidateQueries(serverInfoQuery);
      throw error;
    }
  }

  async function run(): Promise<GuardedOutcome<T>> {
    if (isDisabled) return { kind: "readOnly" };
    try {
      return { kind: "done", value: await send() };
    } catch (error) {
      if (!isUnlockRequired(error)) throw error;
    }
    return new Promise((resolve, reject) => {
      waiting.current = { resolve, reject, pinTaken: false };
      setPadOpen(true);
    });
  }

  const dialog = (
    <AdminPinDialog
      isOpen={padOpen}
      check={async (pin) => {
        const answer = await unlockWithPin(pin);
        setUnlocked(queryClient, true);
        if (waiting.current) waiting.current.pinTaken = true;
        return answer;
      }}
      onOpenChange={(isOpen) => {
        setPadOpen(isOpen);
        const pending = waiting.current;
        if (isOpen || !pending || pending.pinTaken) return;
        waiting.current = null;
        pending.resolve({ kind: "cancelled" });
      }}
      onSuccess={() => {
        const pending = waiting.current;
        waiting.current = null;
        if (!pending) return;
        send().then((value) => {
          pending.resolve({ kind: "done", value });
        }, pending.reject);
      }}
    />
  );

  return { run, isDisabled, dialog };
}
