// TV-remote keys as the Stage's own (spec #244): Back is Esc, Play/Pause is
// Space. A remote's arrows and OK already arrive as the arrow keys and Enter.

/** Back buttons: browsers would otherwise leave the Stage on these. */
const BACK = new Set(["BrowserBack", "GoBack"]);

/**
 * The Stage key a pressed key stands for. Backspace is Esc only outside a
 * text field (the song search box, a Guest's name), where it deletes text.
 */
export function stageKey(key: string, inTextField: boolean): string {
  if (BACK.has(key)) return "Escape";
  if (key === "Backspace" && !inTextField) return "Escape";
  if (key === "MediaPlayPause") return " ";
  return key;
}

/** A key the browser itself acts on (navigating back), never the Stage's. */
export function isBrowserBack(key: string): boolean {
  return BACK.has(key);
}
