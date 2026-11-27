import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "../../ui/Button";
import { HOLD_DURATION_MS } from "../../ui/hold";
import { HoldButton } from "../../ui/HoldButton";
import { startGamepadInput } from "./gamepad";

// A on the Stage's real controls: the keys the pad sends reach them as a
// keyboard's would.

const A = 0;

const pad = {
  connected: true,
  index: 0,
  id: "Fake pad",
  mapping: "standard",
  timestamp: 0,
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({
    pressed: false,
    touched: false,
    value: 0,
  })),
};

function holdA(pressed: boolean) {
  const button = pad.buttons[A];
  if (!button) throw new Error("no A");
  button.pressed = pressed;
  button.value = pressed ? 1 : 0;
}

function frames(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

let stop: () => void = () => undefined;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
      "Date",
    ],
  });
  holdA(false);
  Object.defineProperty(navigator, "getGamepads", {
    configurable: true,
    value: () => [pad],
  });
  stop = startGamepadInput();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("A on the Stage's controls", () => {
  it("presses a focused plain button once", () => {
    const onClick = vi.fn();
    render(
      <button type="button" onClick={onClick}>
        Pick
      </button>,
    );
    screen.getByRole("button", { name: "Pick" }).focus();
    holdA(true);
    frames(20);
    holdA(false);
    frames(20);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("presses a focused Button once", () => {
    const onPress = vi.fn();
    render(<Button onPress={onPress}>Start</Button>);
    screen.getByRole("button", { name: "Start" }).focus();
    holdA(true);
    frames(20);
    holdA(false);
    frames(200);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("runs the 700 ms hold on a hold-to-confirm control while held", () => {
    const onHold = vi.fn();
    render(<HoldButton onHold={onHold}>Skip</HoldButton>);
    const button = screen.getByRole("button", { name: "Skip" });
    button.focus();
    holdA(true);
    frames(20);
    expect(button).toHaveAttribute("data-holding", "true");
    frames(HOLD_DURATION_MS - 40);
    expect(onHold).not.toHaveBeenCalled();
    frames(40);
    expect(onHold).toHaveBeenCalledOnce();
    holdA(false);
    frames(20);
    expect(onHold).toHaveBeenCalledOnce();
  });

  it("asks for a longer hold after a short tap of A, and fires nothing", () => {
    const onHold = vi.fn();
    render(<HoldButton onHold={onHold}>Skip</HoldButton>);
    screen.getByRole("button", { name: "Skip" }).focus();
    holdA(true);
    frames(100);
    holdA(false);
    frames(20);
    expect(screen.getByRole("status")).toHaveTextContent("Hold for a moment");
    frames(2000);
    expect(onHold).not.toHaveBeenCalled();
  });
});
