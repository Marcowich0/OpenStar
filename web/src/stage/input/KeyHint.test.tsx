import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startGamepadInput } from "./gamepad";
import { trackInputDevices, usePadHints } from "./inputDevice";
import { KeyHint } from "./KeyHint";

function HintLine() {
  return <p>{usePadHints() ? "pad" : "keys"}</p>;
}

// Key hints follow the last input device: keys after the keyboard or the
// mouse, pad glyphs after the gamepad.

const Y = 3;

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

function tapY() {
  const button = pad.buttons[Y];
  if (!button) throw new Error("no Y");
  act(() => {
    button.pressed = true;
    vi.advanceTimersByTime(20);
    button.pressed = false;
    vi.advanceTimersByTime(20);
  });
}

const stops: (() => void)[] = [];

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
  Object.defineProperty(navigator, "getGamepads", {
    configurable: true,
    value: () => [pad],
  });
  stops.push(trackInputDevices(), startGamepadInput());
  // Every test starts from the keyboard.
  fireEvent.keyDown(window, { key: "Shift" });
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

describe("key hints", () => {
  it("show the key until the gamepad is used", () => {
    render(<KeyHint keyName="/" />);
    expect(screen.getByText("/")).toBeInTheDocument();
  });

  it("switch to the pad glyph after gamepad input", () => {
    render(<KeyHint keyName="/" />);
    tapY();
    expect(screen.queryByText("/")).not.toBeInTheDocument();
    expect(screen.getByText("Ⓨ")).toBeInTheDocument();
  });

  it("switch back to the key after keyboard input", () => {
    render(<KeyHint keyName="/" />);
    tapY();
    act(() => {
      fireEvent.keyDown(window, { key: "a" });
    });
    expect(screen.getByText("/")).toBeInTheDocument();
  });

  it("switch back to the key after mouse input", () => {
    render(<KeyHint keyName="/" />);
    tapY();
    act(() => {
      fireEvent.pointerDown(window);
    });
    expect(screen.getByText("/")).toBeInTheDocument();
  });

  it("show A, B and Start for Enter, Esc and Space", () => {
    render(
      <>
        <KeyHint keyName="Enter" />
        <KeyHint keyName="Esc" />
        <KeyHint keyName="Space" />
      </>,
    );
    expect(screen.getByText("Enter")).toBeInTheDocument();
    tapY();
    expect(screen.getByText("Ⓐ")).toBeInTheDocument();
    expect(screen.getByText("Ⓑ")).toBeInTheDocument();
    expect(screen.getByText("Start")).toBeInTheDocument();
  });

  it("hide a key no pad button sends, while the gamepad is used", () => {
    render(<KeyHint keyName="M" />);
    expect(screen.getByText("M")).toBeInTheDocument();
    tapY();
    expect(screen.queryByText("M")).not.toBeInTheDocument();
  });

  it("swap a whole hint line for its pad wording", () => {
    render(<HintLine />);
    expect(screen.getByText("keys")).toBeInTheDocument();
    tapY();
    expect(screen.getByText("pad")).toBeInTheDocument();
  });
});
