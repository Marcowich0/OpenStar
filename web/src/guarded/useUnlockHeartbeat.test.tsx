import { QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { unlockQuery } from "../api/queries";
import { createQueryClient } from "../api/queryClient";
import { fakeServer } from "./fakeServer";
import { HEARTBEAT_MS, useUnlockHeartbeat } from "./useUnlockHeartbeat";

const HEARTBEAT = "POST /api/unlock/heartbeat";

function Screen() {
  useUnlockHeartbeat();
  return null;
}

function renderScreen() {
  const queryClient = createQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Screen />
    </QueryClientProvider>,
  );
  return { queryClient, view };
}

/** Lets fetch answers through; only the intervals are fake. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  await settle();
}

let visibility: DocumentVisibilityState = "visible";

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the Unlock heartbeat", () => {
  it("is sent every 60 s while the screen is visible", async () => {
    const server = fakeServer({ unlocked: true });
    renderScreen();
    await settle();

    await advance(HEARTBEAT_MS - 1);
    expect(server.count(HEARTBEAT)).toBe(0);
    await advance(1);
    expect(server.count(HEARTBEAT)).toBe(1);
    await advance(HEARTBEAT_MS);
    expect(server.count(HEARTBEAT)).toBe(2);
    expect(HEARTBEAT_MS).toBe(60_000);
  });

  it("is not sent while the tab is hidden", async () => {
    const server = fakeServer({ unlocked: true });
    renderScreen();
    await settle();

    setVisibility("hidden");
    await advance(HEARTBEAT_MS * 5);
    expect(server.count(HEARTBEAT)).toBe(0);

    setVisibility("visible");
    await settle();
    await advance(HEARTBEAT_MS);
    expect(server.count(HEARTBEAT)).toBe(1);
  });

  it("is not sent without an Unlock", async () => {
    const server = fakeServer({ unlocked: false });
    renderScreen();
    await settle();

    await advance(HEARTBEAT_MS * 3);
    expect(server.count(HEARTBEAT)).toBe(0);
  });

  it("stops once the screen is gone", async () => {
    const server = fakeServer({ unlocked: true });
    const { view } = renderScreen();
    await settle();

    view.unmount();
    await advance(HEARTBEAT_MS * 3);
    expect(server.count(HEARTBEAT)).toBe(0);
  });

  it("learns that the Unlock is gone when the server refuses it", async () => {
    const server = fakeServer({ unlocked: true });
    const { queryClient } = renderScreen();
    await settle();

    server.unlocked = false; // idle expiry, or Lock in another tab
    await advance(HEARTBEAT_MS);
    expect(queryClient.getQueryData(unlockQuery.queryKey)).toEqual({
      unlocked: false,
    });
  });

  it("asks the server again when the tab becomes visible", async () => {
    const server = fakeServer({ unlocked: false });
    const { queryClient } = renderScreen();
    await settle();

    setVisibility("hidden");
    server.unlocked = true; // unlocked in another tab meanwhile
    setVisibility("visible");
    await settle();
    expect(queryClient.getQueryData(unlockQuery.queryKey)).toEqual({
      unlocked: true,
    });
  });
});
