// The key that works a Stage control, shown on it as a key cap (not words).
// While the gamepad was used last (`inputDevice.ts`) it shows the pad button
// that sends the key instead (`gamepad.ts`): Ⓐ for Enter, Ⓑ for Esc, Start
// for Space, Ⓨ for `/`. A key no pad button sends (`M`) hides meanwhile.

import type { ReactNode } from "react";

import { t } from "../../i18n/t";
import { usePadHints } from "./inputDevice";

/** The pad glyph for each key hint a pad button can send. */
function padGlyph(keyName: string): string | null {
  switch (keyName) {
    case "Enter":
      return "Ⓐ";
    case "Esc":
      return "Ⓑ";
    case "Space":
      return t("pad.start");
    case "/":
      return "Ⓨ";
    default:
      return null;
  }
}

export function KeyHint({ keyName }: { keyName: string }) {
  const pad = usePadHints();
  const shown = pad ? padGlyph(keyName) : keyName;
  if (shown === null) return null;
  return (
    <kbd
      aria-hidden="true"
      className="min-w-10 rounded-xl border-2 border-current px-2 text-center font-sans text-2xl leading-8 font-bold opacity-60"
    >
      {shown}
    </kbd>
  );
}

/** A hint line in its keys' wording, or its pad wording after gamepad input. */
export function ByInput({ keys, pad }: { keys: ReactNode; pad: ReactNode }) {
  return usePadHints() ? pad : keys;
}
