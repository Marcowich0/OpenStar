// The last input device used on the Stage (spec #244): the keyboard, the
// mouse or a gamepad. While the gamepad was used last, key hints show pad
// glyphs (`KeyHint`, `usePadHints`). The gamepad's own key events
// (`gamepad.ts`) are marked, so they never count as the keyboard.

import { useSyncExternalStore } from "react";

export type InputDevice = "keyboard" | "mouse" | "gamepad";

let device: InputDevice = "keyboard";
const listeners = new Set<() => void>();
const fromGamepad = new WeakSet<Event>();

function setDevice(next: InputDevice) {
  if (next === device) return;
  device = next;
  for (const listener of listeners) listener();
}

/** Marks `event` as the gamepad's, and the gamepad as used last. */
export function markGamepadEvent(event: Event) {
  fromGamepad.add(event);
  setDevice("gamepad");
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The device used last. */
export function useInputDevice(): InputDevice {
  return useSyncExternalStore(subscribe, () => device);
}

/** True while the gamepad was used last: hints show pad glyphs. */
export function usePadHints(): boolean {
  return useInputDevice() === "gamepad";
}

/** Watches the keyboard and the mouse. Returns the stop function. */
export function trackInputDevices(): () => void {
  const onKey = (event: Event) => {
    if (!fromGamepad.has(event)) setDevice("keyboard");
  };
  const onPointer = () => {
    setDevice("mouse");
  };
  const options = { capture: true, passive: true };
  window.addEventListener("keydown", onKey, options);
  window.addEventListener("pointerdown", onPointer, options);
  window.addEventListener("pointermove", onPointer, options);
  window.addEventListener("wheel", onPointer, options);
  return () => {
    window.removeEventListener("keydown", onKey, options);
    window.removeEventListener("pointerdown", onPointer, options);
    window.removeEventListener("pointermove", onPointer, options);
    window.removeEventListener("wheel", onPointer, options);
  };
}
