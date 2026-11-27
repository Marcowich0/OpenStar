// The sing screen from synthetic state at a frozen Song time, for the painter
// screenshots (#203). Only the test-only `sing-test.html` page renders it; no
// Party state reaches it.

import { useMemo } from "react";

import type { SongMedia } from "../generated/SongMedia";
import { SingBackdrop } from "../stage/sing/SingBackdrop";
import { SingScreen } from "../stage/sing/SingScreen";
import { syntheticSing } from "../stage/sing/syntheticSing";
import type { SingTestSearch } from "./search";

const NO_OFFSET = () => 0;
/** A frozen frame time: the synthetic confetti stays where it was caught. */
const FROZEN = () => 0;

/** No video and no images: the generated tile, so the page needs no network. */
const TILE_ONLY: SongMedia = {
  audio: { url: "", native: false },
  video: null,
  cover: null,
  background: null,
  tileColour: "navy",
};

export function SingTestScreen({ search }: { search: SingTestSearch }) {
  const state = useMemo(
    () => syntheticSing(search.case, search.lyricSize),
    [search.case, search.lyricSize],
  );
  // A frozen clock: every frame draws the same Song time.
  const clock = useMemo(() => ({ songTime: () => search.t }), [search.t]);
  return (
    <SingScreen
      state={state}
      clock={clock}
      avOffset={NO_OFFSET}
      frameTime={FROZEN}
      backdrop={
        // Its own compositing layer, so the tile rasterises the same way
        // whatever else on the page is composited: without one, a theme with
        // no backdrop blur (High contrast) re-rasterises the tile's mark when
        // the screenshot cancels the mic-lost dots' animation.
        <div className="absolute inset-0 will-change-transform">
          <SingBackdrop media={TILE_ONLY} />
        </div>
      }
    />
  );
}
