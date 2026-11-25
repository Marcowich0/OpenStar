import { QueryClient } from "@tanstack/react-query";

import { ApiFailure } from "./api";

const NETWORK_RETRIES = 3;

/**
 * The app's TanStack Query client. Data stays fresh until a change notice
 * over the WebSocket invalidates it (`changeNotices.ts`), so nothing polls
 * and nothing refetches just because a screen opened or the window got the
 * focus back. Only a call that got no answer is retried: a refusal is the
 * server's answer and stays one.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        retry: (failures, error) =>
          failures < NETWORK_RETRIES &&
          error instanceof ApiFailure &&
          error.failure.kind === "network",
      },
      mutations: { retry: false },
    },
  });
}
