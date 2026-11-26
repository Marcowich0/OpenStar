// What this browser knows about its Unlock (v1 spec #45). The server decides
// every guarded request; the browser only keeps a hint, in the
// `unlockQuery` cache entry, for showing the Lock button and sending the
// heartbeat. Every answer that tells something about the Unlock updates it.

import { useQuery, type QueryClient } from "@tanstack/react-query";

import { ApiFailure } from "../api/api";
import { unlockQuery } from "../api/queries";

/** Records what the server just said about this browser's Unlock. */
export function setUnlocked(queryClient: QueryClient, unlocked: boolean) {
  queryClient.setQueryData(unlockQuery.queryKey, { unlocked });
}

/** Whether `error` is the guard's refusal for lack of an Unlock. */
export function isUnlockRequired(error: unknown): boolean {
  return (
    error instanceof ApiFailure &&
    error.failure.kind === "refused" &&
    error.failure.error.code === "unlockRequired"
  );
}

/** Whether `error` is the guard's refusal of a Library write while read-only. */
export function isLibraryReadOnly(error: unknown): boolean {
  return (
    error instanceof ApiFailure &&
    error.failure.kind === "refused" &&
    error.failure.error.code === "libraryReadOnly"
  );
}

/** Whether this browser holds an Unlock, as far as it knows. */
export function useUnlocked(): boolean {
  return useQuery(unlockQuery).data?.unlocked ?? false;
}
