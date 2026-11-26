// The DOM side of a lost-Mic lane (#55, "Mic lost on a lane"): the lane
// header dims to 55 % and the "Mia's mic lost" pill shows. The canvas side
// (the slate wash, no pitch line after the loss) is in the draw list; this
// follows the same draw list each frame, so both change on the same frame.
//
// It writes the DOM directly, and only when a lane's lost state changes, so a
// loss or a return costs no React render.

import type { DrawList } from "./frame";

export interface LaneLostWriter {
  /** Ref callback for lane `lane`'s header (`data-lost` is set while lost). */
  header(lane: number): (element: HTMLElement | null) => void;
  /** Ref callback for lane `lane`'s pill (`hidden` unless lost). */
  pill(lane: number): (element: HTMLElement | null) => void;
  /** Applies one frame's lane entries. */
  apply(list: DrawList): void;
}

export function createLaneLostWriter(): LaneLostWriter {
  const headers: (HTMLElement | null)[] = [];
  const pills: (HTMLElement | null)[] = [];
  /** What each lane's elements show; `undefined` until written. */
  const written: (boolean | undefined)[] = [];

  function write(lane: number, lost: boolean) {
    const header = headers[lane];
    if (header) {
      if (lost) header.setAttribute("data-lost", "");
      else header.removeAttribute("data-lost");
    }
    const pill = pills[lane];
    if (pill) pill.hidden = !lost;
    written[lane] = lost;
  }

  function remember(
    list: (HTMLElement | null)[],
    lane: number,
  ): (element: HTMLElement | null) => void {
    return (element) => {
      list[lane] = element;
      const lost = written[lane];
      // A new element shows the state already written for its lane.
      if (element && lost !== undefined) write(lane, lost);
    };
  }

  return {
    header: (lane) => remember(headers, lane),
    pill: (lane) => remember(pills, lane),
    apply(list) {
      for (const entry of list) {
        if (entry.type !== "lane") continue;
        const lost = entry.lost !== null;
        if (written[entry.lane] !== lost) write(entry.lane, lost);
      }
    },
  };
}
