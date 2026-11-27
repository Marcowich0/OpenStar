import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeLibraryServer, renderLive, settle } from "../admin/adminTestKit";
import type { MicBridge } from "../generated/MicBridge";
import { HOLD_DURATION_MS } from "../ui/hold";
import { ForgetBridge } from "./ForgetBridge";

const PIN = "1234";
const HERMES: MicBridge = {
  bridgeId: "ab12",
  hostName: "hermes",
  open: true,
  channels: [],
  interfaces: [],
};
const FORGET = "DELETE /api/mic-bridges/ab12";

const status = (code: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });

/** A server whose Forget is guarded: `401` until the PIN, then `answer`. */
function bridgeServer({
  unlocked = true,
  answer = status(204),
}: { unlocked?: boolean; answer?: Response } = {}) {
  let hasUnlock = unlocked;
  return fakeLibraryServer({
    "POST /api/unlock": (_url: URL, init: RequestInit) => {
      const { pin } = JSON.parse(init.body as string) as { pin: string };
      if (pin !== PIN) return status(403, { code: "wrongPin" });
      hasUnlock = true;
      return { unlocked: true };
    },
    [FORGET]: () =>
      hasUnlock ? answer.clone() : status(401, { code: "unlockRequired" }),
  });
}

const forgetButton = () =>
  screen.getByRole("button", { name: "Forget the Mic bridge on hermes" });
const pad = () => screen.queryByRole("dialog", { name: "Admin PIN" });

/** Presses Forget for `ms`, then lets go. */
async function holdForget(ms = HOLD_DURATION_MS) {
  vi.useFakeTimers();
  const button = forgetButton();
  act(() => {
    fireEvent.pointerDown(button);
  });
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  act(() => {
    fireEvent.pointerUp(button);
  });
  vi.useRealTimers();
  await settle();
}

async function enterPin(pin: string) {
  for (const digit of pin)
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    });
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
  });
  await settle();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Forget on a bridge group", () => {
  it("does nothing on a short press", async () => {
    const server = bridgeServer();
    await renderLive(<ForgetBridge bridge={HERMES} />);

    await holdForget(HOLD_DURATION_MS - 200);
    expect(server.count(FORGET)).toBe(0);

    act(() => {
      fireEvent.click(forgetButton());
    });
    await settle();
    expect(server.count(FORGET)).toBe(0);
  });

  it("forgets the bridge after a press and hold", async () => {
    const server = bridgeServer();
    await renderLive(<ForgetBridge bridge={HERMES} />);

    await holdForget();

    expect(server.count(FORGET)).toBe(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks for the Admin PIN without an Unlock, then forgets", async () => {
    const server = bridgeServer({ unlocked: false });
    await renderLive(<ForgetBridge bridge={HERMES} />);

    await holdForget();
    expect(pad()).not.toBeNull();
    expect(server.count(FORGET)).toBe(1);

    await enterPin(PIN);

    expect(pad()).toBeNull();
    expect(server.count(FORGET)).toBe(2);
  });

  it("shows the refusal when the bridge is already forgotten", async () => {
    bridgeServer({ answer: status(404, { code: "bridgeNotFound" }) });
    await renderLive(<ForgetBridge bridge={HERMES} />);

    await holdForget();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "That Mic bridge is no longer approved",
    );
  });
});
