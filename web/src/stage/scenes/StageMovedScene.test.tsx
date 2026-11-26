import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveStore } from "../../live/liveStore";
import type { LiveClientOptions } from "../../live/liveClient";
import { HOLD_DURATION_MS } from "../../ui/hold";
import { StageFrame } from "../frame/StageFrame";

const ADMIN_PIN = "4321";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** `POST /api/stage/trust` for a browser that is `remembered` or not. */
function fakeServer(remembered: boolean) {
  const server = { remembered, pins: [] as string[] };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      const { pin } = JSON.parse(init.body as string) as { pin?: string };
      if (pin !== undefined) server.pins.push(pin);
      if (server.remembered)
        return Promise.resolve(json(200, { trusted: true }));
      if (pin === undefined)
        return Promise.resolve(json(403, { code: "stagePinRequired" }));
      if (pin !== ADMIN_PIN)
        return Promise.resolve(json(403, { code: "wrongPin" }));
      server.remembered = true;
      return Promise.resolve(json(200, { trusted: true }));
    }),
  );
  return server;
}

/** A Stage browser that was the Stage until another browser took over. */
async function movedStage() {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const store = createLiveStore((given) => {
    handlers = given;
    return { send: () => true, close: () => {} };
  });
  const takeStageBack = vi.fn();
  const queries = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  render(
    <QueryClientProvider client={queries}>
      <StageFrame
        store={store}
        takeStageBack={takeStageBack}
      />
    </QueryClientProvider>,
  );
  await act(async () => {
    const h = handlers!;
    h.onConnection("open");
    h.onMessage({
      type: "liveState",
      stageId: "main",
      party: null,
      isStage: true,
    });
    h.onMessage({ type: "stageMoved" });
    // Lets the Stage trust check answer.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { takeStageBack };
}

async function hold(name: string) {
  vi.useFakeTimers();
  const button = screen.getByRole("button", { name });
  act(() => {
    fireEvent.pointerDown(button);
  });
  act(() => {
    vi.advanceTimersByTime(HOLD_DURATION_MS);
  });
  vi.useRealTimers();
  // The hold asks the server again before it acts.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function enter(pin: string) {
  for (const digit of pin)
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    });
  const ok = screen.getByRole("button", { name: "OK" });
  await act(async () => {
    fireEvent.pointerDown(ok, { pointerType: "mouse" });
    fireEvent.pointerUp(ok, { pointerType: "mouse" });
    fireEvent.click(ok);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Stage moved here", () => {
  it("says the Stage moved, with the TV drawing and the held button", async () => {
    fakeServer(true);
    await movedStage();
    expect(
      screen.getByRole("heading", {
        name: "The Stage moved to another screen",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Someone opened OpenStar's Stage on another browser, so the party carries on there. Phones stay in the Party and follow it.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("stage-moved-tv")).toHaveClass("animate-pop-in");
    expect(
      screen.getByRole("button", { name: "Make this the Stage again" }),
    ).toBeInTheDocument();
  });

  it("takes the Stage back with the hold alone in a remembered Stage browser", async () => {
    const server = fakeServer(true);
    const { takeStageBack } = await movedStage();
    expect(
      screen.getByText(
        "Hold for a moment. This browser already knows the admin PIN.",
      ),
    ).toBeInTheDocument();
    await hold("Make this the Stage again");
    expect(takeStageBack).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.pins).toEqual([]);
  });

  it("asks any other browser for the Admin PIN after the hold", async () => {
    const server = fakeServer(false);
    const { takeStageBack } = await movedStage();
    expect(
      screen.getByText("Hold for a moment, then enter the admin PIN."),
    ).toBeInTheDocument();
    await hold("Make this the Stage again");
    expect(takeStageBack).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await enter("1111");
    expect(takeStageBack).not.toHaveBeenCalled();
    expect(screen.getByText("That is not the Admin PIN")).toBeInTheDocument();

    await enter(ADMIN_PIN);
    expect(server.pins).toEqual(["1111", ADMIN_PIN]);
    expect(takeStageBack).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

it("asks again at the hold: a browser that lost its Stage cookie gets the pad", async () => {
  const server = fakeServer(true);
  const { takeStageBack } = await movedStage();
  server.remembered = false;
  await hold("Make this the Stage again");
  expect(takeStageBack).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});
