// The key that works a Stage control, shown on it as a key cap (not words).
// While the gamepad was used last (`inputDevice.ts`) it shows the pad button
// that sends the key instead (`padButtons.ts`): Ⓐ for Enter, Ⓑ for Esc,
// Start for Space, Ⓨ for `/`. A key no pad button sends (`M`) hides meanwhile.

import type { ReactNode } from "react";

import { t } from "../../i18n/t";
import { usePadHints } from "./inputDevice";
import { PAD_BUTTONS } from "./padButtons";

/** The glyph of the pad button that sends the key `keyName` names, if any. */
function padGlyph(keyName: string): string | null {
  const button = PAD_BUTTONS.find(({ hint }) => hint === keyName);
  return button ? t(button.glyph) : null;
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
