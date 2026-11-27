// The big cover carousel (v1 spec #55, "Song browser and join card"): one
// Song at a time, its neighbours stepping out to each side, wrapping round.
// ← and → step the selected Song while the focus is on the selected cover
// (or on another element inside a `[data-carousel-arrows]` region, such as
// Sing!); a click on a neighbour selects it; Enter or a click on the
// selected cover picks it. The Songs overlay (#180) reuses it.

import { useLayoutEffect, useRef } from "react";

import type { SongId } from "../../../generated/SongId";
import type { SongSummary } from "../../../generated/SongSummary";
import { t } from "../../../i18n/t";
import { Chip } from "../../../ui/Chip";
import { Cover } from "../../../ui/Cover";
import { isTextField } from "../../frame/focusables";
import { useStageKeys } from "../../frame/stageFrameContext";
import {
  CAROUSEL,
  type CarouselReach,
  FULL_REACH,
  carouselOffset,
  coverPlacement,
  steppedIndex,
} from "./carousel";

/** Marks a region whose focus lets ← and → step the carousel. */
export const CAROUSEL_ARROWS = "data-carousel-arrows";

export interface SongCarouselProps {
  songs: readonly SongSummary[];
  /** Index into `songs` of the selected Song. */
  selected: number;
  onSelect: (index: number) => void;
  /** Enter or a click on the selected cover. */
  onPick: (song: SongSummary) => void;
  /** Neighbours shown on each side; a cover stepping past fades out. */
  reach?: CarouselReach;
  className?: string;
}

export function SongCarousel({
  songs,
  selected,
  onSelect,
  onPick,
  reach = FULL_REACH,
  className = "",
}: SongCarouselProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const count = songs.length;
  const selectedId: SongId | undefined = songs[selected]?.id;

  const arrowsHere = () => {
    const active = document.activeElement;
    return active instanceof Element && active.closest(`[${CAROUSEL_ARROWS}]`);
  };
  const step = (by: number) => {
    if (!arrowsHere() || count === 0) return false;
    onSelect(steppedIndex(selected, by, count));
    return true;
  };
  useStageKeys({
    ArrowLeft: () => step(-1),
    ArrowRight: () => step(1),
  });

  // The Songs arrive after the scene started and set its default focus, so
  // the carousel takes the focus when it appears, unless an overlay or pick
  // list holds it, or someone types in the search box.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (isTextField(active)) return;
    const layer = active?.closest("[data-stage-layer]") ?? null;
    if (
      layer === null ||
      layer === rootRef.current?.closest("[data-stage-layer]")
    )
      selectedRef.current?.focus({ preventScroll: true });
  }, []);

  // The focus follows the selection when it was on a cover.
  useLayoutEffect(() => {
    const active = document.activeElement;
    const root = rootRef.current;
    if (root && active instanceof Node && root.contains(active)) {
      selectedRef.current?.focus({ preventScroll: true });
    }
  }, [selectedId]);

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={t("stage.browser.carousel")}
      {...{ [CAROUSEL_ARROWS]: "" }}
      className={`relative ${className}`}
    >
      {songs.map((song, index) => {
        const offset = carouselOffset(index, selected, count);
        // One more on each side, hidden, so covers slide in and out.
        if (Math.abs(offset) > CAROUSEL.reach + 1) return null;
        const place = coverPlacement(offset, reach);
        const isSelected = offset === 0;
        return (
          <div
            key={song.id}
            data-testid={`carousel-cover-${String(song.id)}`}
            className="absolute top-1/2 left-1/2 cursor-pointer transition-[transform,opacity] duration-600"
            style={{
              width: CAROUSEL.coverPx,
              height: CAROUSEL.coverPx,
              margin: -CAROUSEL.coverPx / 2,
              transform: `translate(${String(place.x)}px, ${String(place.y)}px) scale(${String(place.scale)}) rotate(${String(place.rotate)}deg)`,
              zIndex: place.z,
              opacity: place.shown ? 1 : 0,
              pointerEvents: place.shown ? undefined : "none",
            }}
            aria-hidden={isSelected ? undefined : true}
            onClick={() => {
              if (isSelected) onPick(song);
              else onSelect(index);
            }}
          >
            <div
              ref={isSelected ? selectedRef : undefined}
              tabIndex={-1}
              data-testid={isSelected ? "carousel-selected" : undefined}
              data-song-id={song.id}
              {...(isSelected
                ? {
                    "data-stage-focus": "",
                    "data-stage-default": "",
                    role: "button",
                    "aria-label": song.title,
                  }
                : {})}
              className={`size-full rounded-[14%] outline-none ${isSelected ? "motion-safe:animate-squish" : ""}`}
            >
              <Cover
                src={song.cover}
                song={song}
                rim={CAROUSEL.rimPx}
                className="size-full"
              >
                {song.preparing && (
                  <span className="absolute inset-x-0 bottom-[10%] flex justify-center">
                    <Chip tone="warn" className="text-3xl">
                      {t("songs.preparing")}
                    </Chip>
                  </span>
                )}
              </Cover>
            </div>
          </div>
        );
      })}
    </div>
  );
}
