// Gamepad input on the Stage (spec #244, ticket #275). While a pad is
// connected, the Gamepad API is polled on `requestAnimationFrame` and the pad
// is turned into the keys the Stage already handles, sent to the focused
// element as a keyboard would send them:
//
// - D-pad and left stick: the arrows. The stick counts past a 0.5 deadzone,
//   along its stronger axis only. A held direction repeats after 400 ms,
//   then every 120 ms.
// - A: Enter, B: Esc, Start: Space, Y: `/` (search), as `padButtons.ts`
//   has them. No repeats.
//
// A key down and its key up go where a keyboard's would, so holding A on a
// hold-to-confirm control (`ui/HoldButton`) runs its 700 ms hold. As a
// browser does for a real Enter, A clicks a focused button or link when no
// handler took the key down (react-aria's buttons take it and press on key up).
// Start's Space is the Stage's (start or pause), never the focused control's:
// it goes to the document's body, so the Stage's key bindings get it and a
// focused button or hold button does not (the pad's hold is holding A).
//
// Stage-only: it lives under `stage/` so the Phone bundle never loads it
// (`codeSplit.test.ts`). Gamepad use on Phones and remapping are out of scope.

import { markGamepadEvent } from "./inputDevice";
import { PAD_BUTTONS } from "./padButtons";

/** The D-pad's buttons, and the arrow each one sends. */
const DPAD_KEYS: readonly { button: number; key: string }[] = [
  { button: 12, key: "ArrowUp" },
  { button: 13, key: "ArrowDown" },
  { button: 14, key: "ArrowLeft" },
  { button: 15, key: "ArrowRight" },
];

/** How far the left stick must lean before it counts, of 1. */
export const STICK_DEADZONE = 0.5;
/** A held arrow repeats after this long… */
export const REPEAT_DELAY_MS = 400;
/** …and then this often. */
export const REPEAT_INTERVAL_MS = 120;

const ARROWS = new Set(DPAD_KEYS.map(({ key }) => key));

/** One key the pads hold down. */
interface Held {
  /** When an arrow sends its next repeat; never for the other keys. */
  repeatAt: number | null;
}

function isPressed(pad: Gamepad, button: number): boolean {
  return pad.buttons[button]?.pressed ?? false;
}

/** The arrow the left stick leans towards, along its stronger axis. */
function stickKey(pad: Gamepad): string | null {
  const x = pad.axes[0] ?? 0;
  const y = pad.axes[1] ?? 0;
  if (Math.max(Math.abs(x), Math.abs(y)) <= STICK_DEADZONE) return null;
  if (Math.abs(x) >= Math.abs(y)) return x > 0 ? "ArrowRight" : "ArrowLeft";
  return y > 0 ? "ArrowDown" : "ArrowUp";
}

/** The keys the connected pads hold now. */
function keysHeld(pads: readonly (Gamepad | null)[]): Set<string> {
  const held = new Set<string>();
  for (const pad of pads) {
    if (!pad?.connected) continue;
    for (const { button, key } of [...PAD_BUTTONS, ...DPAD_KEYS]) {
      if (isPressed(pad, button)) held.add(key);
    }
    const stick = stickKey(pad);
    if (stick !== null) held.add(stick);
  }
  return held;
}

/** Keys sent past the focused control, to the Stage itself. */
const STAGE_ONLY_KEYS = new Set([" "]);

/** Sends `key` to the focused element, as a keyboard would. */
function sendKey(type: "keydown" | "keyup", key: string, repeat: boolean) {
  const target = STAGE_ONLY_KEYS.has(key)
    ? document.body
    : (document.activeElement ?? document.body);
  const event = new KeyboardEvent(type, {
    key,
    repeat,
    bubbles: true,
    cancelable: true,
  });
  markGamepadEvent(event);
  target.dispatchEvent(event);
  // A real Enter clicks a focused button or link unless a handler took it.
  if (
    type === "keydown" &&
    key === "Enter" &&
    !event.defaultPrevented &&
    target instanceof HTMLElement &&
    target.matches("button, a[href]")
  ) {
    target.click();
  }
}

/**
 * Starts listening for pads; polls while one is connected. Returns the stop
 * function, which also lets go of any key a pad still holds.
 */
export function startGamepadInput(): () => void {
  if (typeof navigator.getGamepads !== "function") return () => undefined;
  const held = new Map<string, Held>();
  let frame: number | null = null;

  function connectedPads(): readonly (Gamepad | null)[] {
    return navigator.getGamepads();
  }

  function poll() {
    frame = null;
    const pads = connectedPads();
    const down = keysHeld(pads);
    const now = performance.now();
    // Keys let go first, so a stick swung from left to right lets go of
    // ArrowLeft before it sends ArrowRight.
    for (const key of [...held.keys()]) {
      if (down.has(key)) continue;
      held.delete(key);
      sendKey("keyup", key, false);
    }
    for (const key of down) {
      const already = held.get(key);
      if (!already) {
        held.set(key, {
          repeatAt: ARROWS.has(key) ? now + REPEAT_DELAY_MS : null,
        });
        sendKey("keydown", key, false);
      } else if (already.repeatAt !== null && now >= already.repeatAt) {
        already.repeatAt += REPEAT_INTERVAL_MS;
        sendKey("keydown", key, true);
      }
    }
    if (pads.some((pad) => pad?.connected)) {
      frame = requestAnimationFrame(poll);
    }
  }

  function startPolling() {
    if (frame === null) frame = requestAnimationFrame(poll);
  }

  window.addEventListener("gamepadconnected", startPolling);
  window.addEventListener("gamepaddisconnected", startPolling);
  // A pad already connected (and seen) before the Stage opened.
  if (connectedPads().some((pad) => pad?.connected)) startPolling();

  return () => {
    window.removeEventListener("gamepadconnected", startPolling);
    window.removeEventListener("gamepaddisconnected", startPolling);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    for (const key of held.keys()) sendKey("keyup", key, false);
    held.clear();
  };
}
