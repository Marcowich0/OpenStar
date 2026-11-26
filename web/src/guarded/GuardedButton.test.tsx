import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../api/api";
import { createQueryClient } from "../api/queryClient";
import { ADMIN_PIN, fakeServer } from "./fakeServer";
import { GuardedButton } from "./GuardedButton";

const HEARTBEAT = "POST /api/unlock/heartbeat";

/** The stand-in guarded action: an endpoint the server guards. */
const guardedCall = () => api(HEARTBEAT);

function renderWith(children: ReactNode) {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
  return queryClient;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function press(name: string | RegExp) {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

function pressOk() {
  const ok = screen.getByRole("button", { name: "OK" });
  act(() => {
    fireEvent.pointerDown(ok, { pointerType: "mouse" });
    fireEvent.pointerUp(ok, { pointerType: "mouse" });
    fireEvent.click(ok);
  });
}

async function enterPin(pin: string) {
  for (const digit of pin) press(digit);
  pressOk();
  await settle();
}

const pad = () => screen.queryByRole("dialog", { name: "Admin PIN" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a guarded action", () => {
  it("goes straight through while the browser holds an Unlock", async () => {
    const server = fakeServer({ unlocked: true });
    const onDone = vi.fn();
    renderWith(
      <GuardedButton action={guardedCall} onDone={onDone}>
        Forget
      </GuardedButton>,
    );

    press("Forget");
    await settle();

    expect(pad()).toBeNull();
    expect(server.count(HEARTBEAT)).toBe(1);
    expect(onDone).toHaveBeenCalledWith({ unlocked: true });
  });

  it("asks for the Admin PIN without an Unlock, then completes without being started again", async () => {
    const server = fakeServer();
    const onDone = vi.fn();
    renderWith(
      <GuardedButton action={guardedCall} onDone={onDone}>
        Forget
      </GuardedButton>,
    );

    press("Forget");
    await settle();
    expect(pad()).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();

    await enterPin(ADMIN_PIN);

    expect(pad()).toBeNull();
    // Sent once and refused, then sent once more after the PIN.
    expect(server.count(HEARTBEAT)).toBe(2);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("asks for no PIN for a second guarded action after the Unlock", async () => {
    const server = fakeServer();
    const first = vi.fn();
    const second = vi.fn();
    renderWith(
      <>
        <GuardedButton action={guardedCall} onDone={first}>
          First
        </GuardedButton>
        <GuardedButton action={guardedCall} onDone={second}>
          Second
        </GuardedButton>
      </>,
    );

    press("First");
    await settle();
    await enterPin(ADMIN_PIN);
    expect(first).toHaveBeenCalledTimes(1);

    press("Second");
    await settle();
    expect(pad()).toBeNull();
    expect(second).toHaveBeenCalledTimes(1);
    expect(server.count("POST /api/unlock")).toBe(1);
  });

  it("is dropped when the pad is cancelled", async () => {
    const server = fakeServer();
    const onDone = vi.fn();
    renderWith(
      <GuardedButton action={guardedCall} onDone={onDone}>
        Forget
      </GuardedButton>,
    );

    press("Forget");
    await settle();
    press("Cancel");
    await settle();

    expect(pad()).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    expect(server.count(HEARTBEAT)).toBe(1);
  });

  it("asks for the PIN again once the server says the Unlock is gone", async () => {
    const server = fakeServer({ unlocked: true });
    renderWith(<GuardedButton action={guardedCall}>Forget</GuardedButton>);

    press("Forget");
    await settle();
    expect(pad()).toBeNull();

    server.unlocked = false; // idle expiry, or Lock in another tab
    press("Forget");
    await settle();
    expect(pad()).toBeInTheDocument();
  });

  it("is disabled with the reason shown when it writes a read-only Library", async () => {
    const server = fakeServer({
      unlocked: true,
      libraryReadOnly: { code: "songsFolderNotWritable", songsDir: "/songs" },
    });
    const onDone = vi.fn();
    renderWith(
      <GuardedButton action={guardedCall} onDone={onDone} writesLibrary>
        Delete
      </GuardedButton>,
    );
    await settle();

    const button = screen.getByRole("button", { name: "Delete" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    press("Delete");
    await settle();
    expect(onDone).not.toHaveBeenCalled();
    expect(server.count(HEARTBEAT)).toBe(0);
  });

  it("is not disabled by a read-only Library when it does not write the Library", async () => {
    fakeServer({
      unlocked: true,
      libraryReadOnly: { code: "songsFolderNotWritable", songsDir: "/songs" },
    });
    const onDone = vi.fn();
    renderWith(
      <GuardedButton action={guardedCall} onDone={onDone}>
        Forget
      </GuardedButton>,
    );
    await settle();

    press("Forget");
    await settle();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
