// The gamepad's buttons on the Stage (spec #244): which key each one sends
// (`gamepad.ts`) and the glyph a key hint shows for that key after gamepad
// input (`KeyHint.tsx`). One table, so the two never disagree.

import type { MessageKey } from "../../i18n/t";

export interface PadButton {
  /** The button's index in the standard mapping. */
  button: number;
  /** The key it sends, as `KeyboardEvent.key`. */
  key: string;
  /** The key's name on a key hint (`KeyHint`'s `keyName`). */
  hint: string;
  /** The button's glyph. */
  glyph: MessageKey & `pad.${string}`;
}

export const PAD_BUTTONS: readonly PadButton[] = [
  { button: 0, key: "Enter", hint: "Enter", glyph: "pad.a" },
  { button: 1, key: "Escape", hint: "Esc", glyph: "pad.b" },
  { button: 9, key: " ", hint: "Space", glyph: "pad.start" },
  { button: 3, key: "/", hint: "/", glyph: "pad.y" },
];
