import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminPinDialog } from "./AdminPinDialog";

const ADMIN_PIN = "4321";

/**
 * A fake server for `POST /api/unlock`: the Admin PIN opens it, any other
 * PIN is `403 wrongPin`, and while `waitSeconds` is set every attempt is
 * `429 adminPinWait` (no PIN is checked during a wait).
 */
function fakeServer() {
  const server = { attempts: [] as string[], waitSeconds: 0 };
  const json = (status: number, body: unknown, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      expect(url).toBe("/api/unlock");
      expect(init.method).toBe("POST");
      const { pin } = JSON.parse(init.body as string) as { pin: string };
      server.attempts.push(pin);
      if (server.waitSeconds > 0)
        return Promise.resolve(
          json(
            429,
            {
              code: "adminPinWait",
              params: { secondsLeft: server.waitSeconds },
            },
            { "Retry-After": String(server.waitSeconds) },
          ),
        );
      if (pin === ADMIN_PIN)
        return Promise.resolve(json(200, { unlocked: true }));
      return Promise.resolve(json(403, { code: "wrongPin" }));
    }),
  );
  return server;
}

function renderPad() {
  const onSuccess = vi.fn();
  const onOpenChange = vi.fn();
  const view = render(
    <AdminPinDialog isOpen onOpenChange={onOpenChange} onSuccess={onSuccess} />,
  );
  return { onSuccess, onOpenChange, view };
}

function press(name: string) {
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

function enter(pin: string) {
  for (const digit of pin) press(digit);
  pressOk();
}

/** Lets the fake server's answer reach the pad. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const pinField = () => screen.getByRole("img", { name: /digits? entered/ });

const dotsEntered = () => pinField().getAttribute("aria-label");

/** The dots the PIN field draws, filled or not. */
const dots = () => pinField().querySelectorAll("[data-testid=pin-dot]");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AdminPinDialog", () => {
  it("shows the Admin PIN form of the number pad", () => {
    fakeServer();
    renderPad();
    expect(
      screen.getByRole("dialog", { name: "Admin PIN" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("pin-lock")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "OK" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("shows one filled dot per digit typed, and a hint when there are none", () => {
    fakeServer();
    renderPad();
    // No digits: no dots at all, so the field does not suggest a length.
    expect(dots()).toHaveLength(0);
    expect(pinField()).toHaveTextContent("Enter the PIN");

    for (const digit of "4321") press(digit);
    expect(dotsEntered()).toBe("4 digits entered");
    expect(dots()).toHaveLength(4);
    for (const dot of dots()) expect(dot).toHaveAttribute("data-filled");
    expect(pinField()).not.toHaveTextContent("Enter the PIN");

    for (const digit of "5678") press(digit);
    expect(dotsEntered()).toBe("8 digits entered");
    expect(dots()).toHaveLength(8);
    for (const dot of dots()) expect(dot).toHaveAttribute("data-filled");

    // A ninth digit is not taken.
    press("9");
    expect(dots()).toHaveLength(8);
  });

  it("on a wrong PIN clears the entry and says the PIN is wrong", async () => {
    const server = fakeServer();
    const { onSuccess } = renderPad();
    enter("1111");
    await settle();
    expect(server.attempts).toEqual(["1111"]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "That is not the Admin PIN",
    );
    expect(dotsEntered()).toBe("0 digits entered");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("on the correct PIN closes the pad and calls the success callback", async () => {
    const server = fakeServer();
    const { onSuccess, onOpenChange } = renderPad();
    enter(ADMIN_PIN);
    await settle();
    expect(server.attempts).toEqual([ADMIN_PIN]);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("after a wrong PIN takes a new attempt", async () => {
    const server = fakeServer();
    const { onSuccess } = renderPad();
    enter("1111");
    await settle();
    enter(ADMIN_PIN);
    await settle();
    expect(server.attempts).toEqual(["1111", ADMIN_PIN]);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("during a wait counts down m:ss to zero and takes no attempt until then", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const server = fakeServer();
    server.waitSeconds = 62;
    const { onSuccess } = renderPad();
    enter("1111");
    await settle();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Too many wrong PINs, try again in 1:02");
    expect(dotsEntered()).toBe("0 digits entered");

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(status).toHaveTextContent("Too many wrong PINs, try again in 0:59");

    // Digits, typed or pressed, and OK do nothing while the wait runs.
    for (const digit of ADMIN_PIN) press(digit);
    act(() => {
      fireEvent.keyDown(document.body, { key: "5" });
      fireEvent.keyDown(document.body, { key: "Enter" });
    });
    pressOk();
    await settle();
    expect(dotsEntered()).toBe("0 digits entered");
    expect(server.attempts).toEqual(["1111"]);

    act(() => {
      vi.advanceTimersByTime(58_000);
    });
    expect(status).toHaveTextContent("Too many wrong PINs, try again in 0:01");
    server.waitSeconds = 0;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(status).toHaveTextContent("");

    enter(ADMIN_PIN);
    await settle();
    expect(server.attempts).toEqual(["1111", ADMIN_PIN]);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("says so when the server cannot be reached, keeping the entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("offline"))),
    );
    const { onSuccess } = renderPad();
    enter("1111");
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent(
      "The PIN could not be checked. Try again.",
    );
    expect(dotsEntered()).toBe("4 digits entered");
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
