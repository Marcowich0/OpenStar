import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStageTrust } from "../../live/stageTrust";
import { StageTrustGate } from "./StageTrustGate";

const ADMIN_PIN = "4321";

/** `POST /api/stage/trust` for a browser that is `remembered` or not. */
function fakeServer(remembered: boolean) {
  const server = { remembered };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      const { pin } = JSON.parse(init.body as string) as { pin?: string };
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

function renderGate() {
  const trust = createStageTrust();
  render(
    <StageTrustGate trust={trust}>
      <p>the Stage</p>
    </StageTrustGate>,
  );
  // What the live client does before it opens `/ws/stage`.
  void trust.whenTrusted();
  return trust;
}

function enter(pin: string) {
  for (const digit of pin)
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    });
  const ok = screen.getByRole("button", { name: "OK" });
  act(() => {
    fireEvent.pointerDown(ok, { pointerType: "mouse" });
    fireEvent.pointerUp(ok, { pointerType: "mouse" });
    fireEvent.click(ok);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StageTrustGate", () => {
  it("shows a browser that is not remembered the Admin PIN pad before anything else", async () => {
    fakeServer(false);
    renderGate();
    expect(
      await screen.findByRole("dialog", { name: "Admin PIN" }),
    ).toBeVisible();
    expect(screen.queryByText("the Stage")).toBeNull();

    enter("0000");
    expect(await screen.findByText("That is not the Admin PIN")).toBeVisible();
    expect(screen.queryByText("the Stage")).toBeNull();

    enter(ADMIN_PIN);
    expect(await screen.findByText("the Stage")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Admin PIN" })).toBeNull();
  });

  it("shows a remembered browser no pad", async () => {
    fakeServer(true);
    renderGate();
    expect(await screen.findByText("the Stage")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Admin PIN" })).toBeNull();
  });

  it("offers the pad again after Cancel", async () => {
    fakeServer(false);
    renderGate();
    await screen.findByRole("dialog", { name: "Admin PIN" });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    const again = await screen.findByRole("button", {
      name: "Enter the Admin PIN",
    });
    expect(screen.queryByText("the Stage")).toBeNull();
    act(() => {
      fireEvent.click(again);
    });
    expect(
      await screen.findByRole("dialog", { name: "Admin PIN" }),
    ).toBeVisible();
  });
});
