// The DOM side of the Line rating pops (#55, "Line ratings"): one element per
// lane in the headers layer, placed beside the lane header. Each frame it
// follows the draw list's `lineRating` entries (`lineRating.ts`): shown while
// its lane has one, with the word through `t()`, scaled, faded and risen as
// the entry says. It writes the DOM directly, so a pop costs no React render;
// the text changes only when the word does.

import { t } from "../../i18n/t";
import type { LineRatingKey } from "../../scoring/scorer";
import { tokenVar } from "../../theme/tokens";
import type { DrawList } from "./frame";
import { MAX_LANES } from "./laneLayout";

export interface LineRatingWriter {
  /** Ref callback for lane `lane`'s word element. */
  word(lane: number): (element: HTMLElement | null) => void;
  /** Applies one frame's `lineRating` entries. */
  apply(list: DrawList): void;
}

export function createLineRatingWriter(): LineRatingWriter {
  const elements: (HTMLElement | null)[] = [];
  /** The word each element shows; `null` while hidden. */
  const words: (LineRatingKey | null)[] = [];
  const shown = new Uint8Array(MAX_LANES);

  return {
    word: (lane) => (element) => {
      elements[lane] = element;
      words[lane] = null;
    },
    apply(list) {
      shown.fill(0);
      for (const entry of list) {
        if (entry.type !== "lineRating") continue;
        const element = elements[entry.lane];
        if (!element) continue;
        shown[entry.lane] = 1;
        if (words[entry.lane] !== entry.word) {
          element.textContent = t(entry.word);
          element.style.color = tokenVar(entry.colour);
          element.style.fontSize = `${String(entry.size)}px`;
          words[entry.lane] = entry.word;
        }
        element.style.left = `${String(entry.x)}px`;
        element.style.top = `${String(entry.y - entry.rise)}px`;
        element.style.transform = `translate(-50%, -50%) scale(${String(entry.scale)})`;
        element.style.opacity = String(entry.alpha);
        element.hidden = false;
      }
      for (let lane = 0; lane < elements.length; lane++) {
        const element = elements[lane];
        if (!element || shown[lane] === 1 || element.hidden) continue;
        element.hidden = true;
        words[lane] = null;
      }
    },
  };
}
