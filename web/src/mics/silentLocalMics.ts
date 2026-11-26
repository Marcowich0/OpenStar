// Which switched-on Local mics the Stage reports as sending no sound
// (`reportSilentLocalMics`, v1 spec #51 "Mic warnings"): the present ones
// whose input has been exact digital silence for more than 2 s, by the rule
// of `digitalSilence.ts`, on either path. A Stage-browser Local mic's zeros
// come from its worklet's windows (`LocalMicCapture.digitalZero`), a bridge
// Local mic's from its bridge's levels (`BridgeLevels.digitalZero`). The
// server turns the report into seat warnings.

import type { PartyLocalMic } from "../generated/PartyLocalMic";
import { createDigitalSilenceWatch } from "./digitalSilence";

/** Where a Local mic's newest exact-zero flag is read; `null`: unknown. */
export interface ZeroSources {
  browser: (deviceId: string, channel: number) => boolean | null;
  bridge: (localMicId: string) => boolean | null;
}

export interface SilentLocalMics {
  /**
   * Looks at every Local mic of `localMics` (the Party's switched-on ones)
   * at `now`, ms; the silent ones, in id order. An unplugged one, or one
   * whose zeros are unknown, is forgotten and counts afresh when back.
   */
  look: (
    localMics: readonly PartyLocalMic[],
    sources: ZeroSources,
    now: number,
  ) => string[];
}

export function createSilentLocalMics(): SilentLocalMics {
  const watch = createDigitalSilenceWatch();
  let watched = new Set<string>();
  return {
    look(localMics, sources, now) {
      const seen = new Set<string>();
      for (const mic of localMics) {
        const zero = !mic.present
          ? null
          : mic.source.kind === "browser"
            ? sources.browser(mic.source.deviceId, mic.source.channel)
            : sources.bridge(mic.localMicId);
        if (zero === null) {
          watch.forget(mic.localMicId);
          continue;
        }
        seen.add(mic.localMicId);
        watch.observe(mic.localMicId, zero, now);
      }
      for (const id of watched) if (!seen.has(id)) watch.forget(id);
      watched = seen;
      return watch.silent(now);
    },
  };
}
