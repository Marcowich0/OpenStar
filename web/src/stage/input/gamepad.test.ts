import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startGamepadInput } from "./gamepad";

// A fake standard-mapping pad behind a fake `navigator.getGamepads`, with
// `requestAnimationFrame` and the clock faked, so time is in our hands.

interface FakePad {
  connected: boolean;
  index: number;
  id: string;
  mapping: GamepadMappingType;
  timestamp: number;
  axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
}

const A = 0;
const B = 1;
const Y = 3;
const START = 9;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;

let pads: (FakePad | null)[] = [];
const getGamepads = vi.fn(() => pads as unknown as (Gamepad | null)[]);

function fakePad(index = 0): FakePad {
  return {
    connected: true,
    index,
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
}

function connect(pad = fakePad()): FakePad {
  pads[pad.index] = pad;
  window.dispatchEvent(new Event("gamepadconnected"));
  return pad;
}

function disconnect(pad: FakePad) {
  pads[pad.index] = null;
  window.dispatchEvent(new Event("gamepaddisconnected"));
}

function press(pad: FakePad, button: number, pressed = true) {
  const state = pad.buttons[button];
  if (!state) throw new Error(`no button ${String(button)}`);
  state.pressed = pressed;
  state.value = pressed ? 1 : 0;
}

/** Every key event that reaches the window, as "down Enter", "up Enter". */
let keys: string[] = [];
function record(event: KeyboardEvent) {
  keys.push(
    `${event.type === "keydown" ? "down" : "up"} ${event.key}${event.repeat ? " (repeat)" : ""}`,
  );
}

function frames(ms: number) {
  vi.advanceTimersByTime(ms);
}

let stop: (() => void) | undefined;

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
  pads = [];
  keys = [];
  getGamepads.mockClear();
  Object.defineProperty(navigator, "getGamepads", {
    configurable: true,
    value: getGamepads,
  });
  window.addEventListener("keydown", record);
  window.addEventListener("keyup", record);
  stop = startGamepadInput();
});

afterEach(() => {
  stop?.();
  window.removeEventListener("keydown", record);
  window.removeEventListener("keyup", record);
  vi.useRealTimers();
});

describe("the Stage's gamepad input", () => {
  it("turns A, B, Start and Y into Enter, Esc, Space and /", () => {
    const pad = connect();
    for (const button of [A, B, START, Y]) {
      press(pad, button);
      frames(20);
      press(pad, button, false);
      frames(20);
    }
    expect(keys).toEqual([
      "down Enter",
      "up Enter",
      "down Escape",
      "up Escape",
      "down  ",
      "up  ",
      "down /",
      "up /",
    ]);
  });

  it("turns the D-pad into the arrows", () => {
    const pad = connect();
    for (const button of [DPAD_UP, DPAD_DOWN, DPAD_LEFT, DPAD_RIGHT]) {
      press(pad, button);
      frames(20);
      press(pad, button, false);
      frames(20);
    }
    expect(keys).toEqual([
      "down ArrowUp",
      "up ArrowUp",
      "down ArrowDown",
      "up ArrowDown",
      "down ArrowLeft",
      "up ArrowLeft",
      "down ArrowRight",
      "up ArrowRight",
    ]);
  });

  it("repeats a held direction after 400 ms, then every 120 ms", () => {
    const pad = connect();
    press(pad, DPAD_DOWN);
    frames(20);
    const start = performance.now();
    const downs = () => keys.filter((k) => k.startsWith("down")).length;
    expect(keys).toEqual(["down ArrowDown"]);
    frames(390 - (performance.now() - start));
    expect(downs()).toBe(1);
    frames(30); // past 400 ms
    expect(keys.at(-1)).toBe("down ArrowDown (repeat)");
    expect(downs()).toBe(2);
    frames(100); // 120 ms after the first repeat has not passed yet
    expect(downs()).toBe(2);
    frames(40);
    expect(downs()).toBe(3);
    frames(120 * 3);
    expect(downs()).toBe(6);
    press(pad, DPAD_DOWN, false);
    frames(20);
    expect(keys.at(-1)).toBe("up ArrowDown");
  });

  it("never repeats A, B, Start or Y", () => {
    const pad = connect();
    press(pad, A);
    frames(2000);
    expect(keys).toEqual(["down Enter"]);
  });

  it("turns the left stick into the arrows past a 0.5 deadzone", () => {
    const pad = connect();
    pad.axes = [0.45, -0.45, 0, 0];
    frames(100);
    expect(keys).toEqual([]);
    pad.axes = [0.6, 0, 0, 0];
    frames(20);
    pad.axes = [0, 0, 0, 0];
    frames(20);
    pad.axes = [-0.6, 0, 0, 0];
    frames(20);
    pad.axes = [0, -0.9, 0, 0];
    frames(20);
    pad.axes = [0, 1, 0, 0];
    frames(20);
    pad.axes = [0, 0, 0, 0];
    frames(20);
    expect(keys).toEqual([
      "down ArrowRight",
      "up ArrowRight",
      "down ArrowLeft",
      "up ArrowLeft",
      "down ArrowUp",
      "up ArrowUp",
      "down ArrowDown",
      "up ArrowDown",
    ]);
  });

  it("moves the stick along its stronger axis only", () => {
    const pad = connect();
    pad.axes = [0.7, 0.6, 0, 0];
    frames(20);
    expect(keys).toEqual(["down ArrowRight"]);
  });

  it("repeats a held stick like a held D-pad", () => {
    const pad = connect();
    pad.axes = [0, 0.8, 0, 0];
    frames(20);
    frames(400 + 120 + 20); // and a frame
    expect(keys).toEqual([
      "down ArrowDown",
      "down ArrowDown (repeat)",
      "down ArrowDown (repeat)",
    ]);
  });

  it("polls only while a pad is connected", () => {
    // One look at start, for a pad connected before; no polling.
    const atStart = getGamepads.mock.calls.length;
    expect(atStart).toBeLessThanOrEqual(1);
    frames(500);
    expect(getGamepads.mock.calls.length).toBe(atStart);
    const pad = connect();
    frames(100);
    const polled = getGamepads.mock.calls.length;
    expect(polled).toBeGreaterThan(3);
    disconnect(pad);
    frames(100);
    const after = getGamepads.mock.calls.length;
    frames(1000);
    expect(getGamepads.mock.calls.length).toBe(after);
    expect(after - polled).toBeLessThanOrEqual(2);
  });

  it("lets go of the keys a pad held when it disconnects", () => {
    const pad = connect();
    press(pad, A);
    press(pad, DPAD_LEFT);
    frames(20);
    disconnect(pad);
    frames(20);
    expect(keys).toEqual([
      "down Enter",
      "down ArrowLeft",
      "up Enter",
      "up ArrowLeft",
    ]);
  });

  it("keeps polling while a second pad stays connected", () => {
    const first = connect(fakePad(0));
    const second = connect(fakePad(1));
    frames(20);
    disconnect(first);
    frames(20);
    press(second, B);
    frames(20);
    expect(keys).toEqual(["down Escape"]);
  });

  it("polls a pad connected before it started", () => {
    stop?.();
    pads = [fakePad()];
    stop = startGamepadInput();
    const pad = pads[0];
    if (!pad) throw new Error("no pad");
    press(pad, Y);
    frames(20);
    expect(keys).toEqual(["down /"]);
  });

  it("stops polling and lets go of held keys when stopped", () => {
    const pad = connect();
    press(pad, START);
    frames(20);
    stop?.();
    stop = undefined;
    const calls = getGamepads.mock.calls.length;
    frames(500);
    expect(getGamepads.mock.calls.length).toBe(calls);
    expect(keys).toEqual(["down  ", "up  "]);
  });
});
