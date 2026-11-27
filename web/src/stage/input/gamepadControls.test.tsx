import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "../../ui/Button";
import { HOLD_DURATION_MS } from "../../ui/hold";
import { HoldButton } from "../../ui/HoldButton";
import { startGamepadInput } from "./gamepad";

// A on the Stage's real controls: the keys the pad sends reach them as a
// keyboard's would.

const A = 0;
const START = 9;

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

function hold(index: number, pressed: boolean) {
  const button = pad.buttons[index];
  if (!button) throw new Error(`no button ${String(index)}`);
  button.pressed = pressed;
  button.value = pressed ? 1 : 0;
}

function holdA(pressed: boolean) {
  hold(A, pressed);
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
  hold(START, false);
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

describe("Start on the Stage's controls", () => {
  it("starts no hold on a focused hold-to-confirm control, and still sends Space", () => {
    const onHold = vi.fn();
    const spaces: string[] = [];
    const onKey = (event: KeyboardEvent) => {
      if (event.key === " ") spaces.push(event.type);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    try {
      render(<HoldButton onHold={onHold}>Skip</HoldButton>);
      const button = screen.getByRole("button", { name: "Skip" });
      button.focus();
      hold(START, true);
      frames(20);
      expect(button).not.toHaveAttribute("data-holding");
      frames(HOLD_DURATION_MS + 100);
      hold(START, false);
      frames(20);
      expect(onHold).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).not.toHaveTextContent(
        "Hold for a moment",
      );
      expect(spaces).toEqual(["keydown", "keyup"]);
    } finally {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    }
  });

  it("presses no focused Button", () => {
    const onPress = vi.fn();
    render(<Button onPress={onPress}>Start</Button>);
    screen.getByRole("button", { name: "Start" }).focus();
    hold(START, true);
    frames(20);
    hold(START, false);
    frames(200);
    expect(onPress).not.toHaveBeenCalled();
  });
});
