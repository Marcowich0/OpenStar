// The search box at the top of the song browser (and of the Songs overlay):
// `/` or the Search button opens it, typing narrows the carousel, the filter
// chips are the Remote's Songs tab's. While closed, the Search button stands
// where the box opens, so a mouse finds it too. ↓ moves from the box to the
// chips and on to the carousel, ↑ back; Enter in the box moves to the
// carousel, so a second Enter picks the Song found; Esc clears the search and
// closes the box. Letters typed in the box are text, never Stage keys.

import { useLayoutEffect, useRef, type ReactNode } from "react";

import { t } from "../../i18n/t";
import {
  chipActive,
  chipLabel,
  filterChips,
  noFilter,
} from "../../phone/songs/songChips";
import type { SongFilters } from "../../generated/SongFilters";
import { Icon } from "../../ui/Icon";
import { focusDefault, isTextField } from "../frame/focusables";
import { KeyHint } from "../input/KeyHint";
import { useStageKeys } from "../frame/stageFrameContext";
import { useSongSearch } from "./songSearch";

const CHIP =
  "shrink-0 cursor-pointer rounded-full px-5 py-1.5 text-2xl font-semibold whitespace-nowrap shadow-ledge-sm";

/** A control in the search's row, as tall as the box: the Search button, Mute. */
export const SEARCH_ROW_CONTROL =
  "inline-flex h-[72px] shrink-0 cursor-pointer items-center gap-3 rounded-full px-7 text-[30px] font-semibold shadow-ledge-sm";

/** Where the focus goes once the box has rendered. */
type FocusAsk = "box" | "carousel" | null;

export function StageSongSearch({
  filters,
  align = "center",
  boxClassName = "w-[760px]",
  controls,
  className = "",
}: {
  /** The Library's filter values; no chips while they load. */
  filters: SongFilters | undefined;
  /** The row and the chips under it: centred, or from the left edge. */
  align?: "center" | "start";
  /** The box's width. */
  boxClassName?: string;
  /** More controls in the row, after the Search button or the box. */
  controls?: ReactNode;
  className?: string;
}) {
  const search = useSongSearch();
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLInputElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  // Asked by a key, done once the box has rendered (or closed).
  const focusAsk = useRef<FocusAsk>(null);

  const layer = () => rootRef.current?.closest("[data-stage-layer]") ?? null;
  const inChips = () => {
    const active = document.activeElement;
    return active instanceof Node && !!chipsRef.current?.contains(active);
  };

  const focusCarousel = () => {
    const root = layer();
    if (root) focusDefault(root);
  };

  useLayoutEffect(() => {
    const ask = focusAsk.current;
    if (ask === null) return;
    focusAsk.current = null;
    if (ask === "box") boxRef.current?.focus({ preventScroll: true });
    else focusCarousel();
  });

  const openBox = () => {
    if (boxRef.current) boxRef.current.focus({ preventScroll: true });
    else {
      focusAsk.current = "box";
      search.openBox();
    }
  };

  useStageKeys({
    "/": () => {
      if (isTextField(document.activeElement)) return false;
      openBox();
      return true;
    },
    Enter: () => {
      if (document.activeElement !== boxRef.current) return false;
      focusCarousel();
      return true;
    },
    ArrowDown: () => {
      if (!search.open) return false;
      if (document.activeElement === boxRef.current) {
        chipsRef.current
          ?.querySelector<HTMLElement>("button")
          ?.focus({ preventScroll: true });
        return true;
      }
      if (inChips()) {
        focusCarousel();
        return true;
      }
      return false;
    },
    ArrowUp: () => {
      if (!search.open || !inChips()) return false;
      boxRef.current?.focus({ preventScroll: true });
      return true;
    },
    Escape: () => {
      if (!search.open) return false;
      focusAsk.current = "carousel";
      search.close();
      return true;
    },
  });

  // The root stays mounted while closed, so Esc can still move the focus.
  return (
    <div
      ref={rootRef}
      className={`flex flex-col ${align === "start" ? "items-start" : "items-center"} ${className}`}
    >
      <div className="flex items-center gap-4">
        {search.open ? (
          <label
            // The Stage's focus ring, on the pill rather than the bare input.
            className={`flex h-[72px] items-center gap-4 rounded-full bg-surface px-8 shadow-ledge-sm ring-4 ring-ledge focus-within:ring-6 focus-within:ring-yellow focus-within:outline-4 focus-within:outline-offset-6 focus-within:outline-ink ${boxClassName}`}
          >
            <Icon name="search" className="size-9 shrink-0 text-ink-2" />
            <input
              ref={boxRef}
              type="search"
              data-stage-focus=""
              aria-label={t("songs.search")}
              placeholder={t("songs.search")}
              autoComplete="off"
              style={{ boxShadow: "none", scale: "none" }}
              value={search.text}
              onChange={(event) => {
                search.setText(event.target.value);
              }}
              className="min-w-0 grow bg-transparent text-[34px] font-medium outline-none placeholder:text-mute [&::-webkit-search-cancel-button]:hidden"
            />
          </label>
        ) : (
          <button
            type="button"
            aria-keyshortcuts="/"
            onClick={openBox}
            className={`${SEARCH_ROW_CONTROL} bg-surface text-ink`}
          >
            <Icon name="search" className="size-9" />
            {t("stage.browser.search")}
            <KeyHint keyName="/" />
          </button>
        )}
        {controls}
      </div>
      {search.open && (
        <div
          ref={chipsRef}
          role="group"
          aria-label={t("songs.filters")}
          className="flex max-w-full gap-3 overflow-x-auto px-4 pt-3.5 pb-3 [scrollbar-width:none]"
        >
          <FilterButton
            on={noFilter(search.filters)}
            onPress={search.clearFilters}
          >
            {t("songs.all")}
          </FilterButton>
          {(filters ? filterChips(filters) : []).map((chip) => (
            <FilterButton
              key={`${chip.field}-${String(chip.value)}`}
              on={chipActive(search.filters, chip)}
              onPress={() => {
                search.toggle(chip);
              }}
            >
              {chipLabel(chip)}
            </FilterButton>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterButton({
  on,
  onPress,
  children,
}: {
  on: boolean;
  onPress: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPress}
      onFocus={(event) => {
        // A chip the arrows reach scrolls into the row's view.
        // (jsdom has no scrollIntoView.)
        const chip: Partial<Pick<HTMLElement, "scrollIntoView">> =
          event.currentTarget;
        chip.scrollIntoView?.({
          block: "nearest",
          inline: "nearest",
        });
      }}
      className={`${CHIP} ${on ? "bg-ink-fill text-white" : "bg-surface text-ink"}`}
    >
      {children}
    </button>
  );
}
