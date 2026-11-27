// The Songs tab (v1 spec #49, "Songs tab and the Request sheet"): a search
// box, a row of filter chips and the list of Song rows, all on the Library
// index's search and filter fields (`GET /api/songs`). Tapping a row or its
// + opens the Request sheet. No A to Z scrubber and no cover carousel.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { Input, SearchField } from "react-aria-components";

import { songsQuery } from "../../api/queries";
import type { SongId } from "../../generated/SongId";
import type { SongSummary } from "../../generated/SongSummary";
import { t } from "../../i18n/t";
import type { LiveStore } from "../../live/liveStore";
import { Cover } from "../../ui/Cover";
import { Icon } from "../../ui/Icon";
import { RequestSheet } from "./RequestSheet";
import {
  chipActive,
  chipLabel,
  filterChips,
  noFilter,
  songListQuery,
  toggleChip,
  type SongFilterQuery,
} from "./songChips";
import { SongTags } from "./SongTags";

const CHIP =
  "shrink-0 cursor-pointer rounded-full px-3.5 py-1.5 text-sm font-semibold whitespace-nowrap shadow-ledge-sm outline-none focus-visible:outline-4 focus-visible:outline-yellow";

export function SongsTab({ store }: { store: LiveStore }) {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<SongFilterQuery>({});
  const [sheetSong, setSheetSong] = useState<SongId | null>(null);
  const query = songListQuery(filters, useDeferredValue(search));
  const list = useQuery({
    ...songsQuery(query),
    placeholderData: keepPreviousData,
  });
  const chips = list.data ? filterChips(list.data.filters) : [];

  return (
    <div className="flex flex-col gap-2 pt-1">
      <SearchField
        aria-label={t("songs.search")}
        value={search}
        onChange={setSearch}
        className="flex h-13 items-center gap-2.5 rounded-full bg-white px-4.5 ring-2 ring-ledge"
      >
        <Icon name="search" className="size-5.5 shrink-0 text-ink-2" />
        <Input
          placeholder={t("songs.search")}
          autoComplete="off"
          className="min-w-0 grow bg-transparent text-lg outline-none placeholder:text-mute [&::-webkit-search-cancel-button]:hidden"
        />
      </SearchField>

      <div
        role="group"
        aria-label={t("songs.filters")}
        className="-mx-5 flex gap-2 overflow-x-auto px-5 pt-1 pb-2.5 [scrollbar-width:none]"
      >
        <button
          type="button"
          aria-pressed={noFilter(filters)}
          onClick={() => {
            setFilters({});
          }}
          className={`${CHIP} ${noFilter(filters) ? "bg-ink text-white" : "bg-white text-ink"}`}
        >
          {t("songs.all")}
        </button>
        {chips.map((chip) => {
          const on = chipActive(filters, chip);
          return (
            <button
              key={`${chip.field}-${String(chip.value)}`}
              type="button"
              aria-pressed={on}
              onClick={() => {
                setFilters((current) => toggleChip(current, chip));
              }}
              className={`${CHIP} ${on ? "bg-ink text-white" : "bg-white text-ink"}`}
            >
              {chipLabel(chip)}
            </button>
          );
        })}
      </div>

      {list.data ? (
        list.data.songs.length === 0 ? (
          <p className="py-6 text-center text-mute">{t("songs.none")}</p>
        ) : (
          <ul aria-label={t("songs.list")} className="flex flex-col gap-2.5">
            {list.data.songs.map((song) => (
              <SongRow
                key={song.id}
                song={song}
                onOpen={() => {
                  setSheetSong(song.id);
                }}
              />
            ))}
          </ul>
        )
      ) : (
        <p role="status" className="py-6 text-center text-ink-2">
          {t(list.isError ? "songs.failed" : "songs.loading")}
        </p>
      )}

      <RequestSheet
        store={store}
        target={sheetSong === null ? null : { kind: "add", songId: sheetSong }}
        onClose={() => {
          setSheetSong(null);
        }}
      />
    </div>
  );
}

function SongRow({ song, onOpen }: { song: SongSummary; onOpen: () => void }) {
  return (
    <li className="flex items-center gap-3">
      <Cover
        src={song.cover}
        song={song}
        rim={3}
        className="w-14"
      />
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 grow cursor-pointer flex-col items-start gap-0.5 rounded-card-sm text-left outline-none focus-visible:outline-4 focus-visible:outline-yellow"
      >
        <span className="w-full truncate text-lg leading-tight font-semibold">
          {song.title}
        </span>
        <span className="w-full truncate text-sm text-ink-2">
          {song.artist}
        </span>
        <SongTags
          preparing={song.preparing}
          duet={song.duet}
          year={song.year}
          best={song.topHighScore?.total ?? null}
          className="mt-1"
        />
      </button>
      <button
        type="button"
        aria-label={t("songs.add", { song: song.title })}
        onClick={onOpen}
        className="flex size-12 shrink-0 cursor-pointer items-center justify-center rounded-full bg-green text-white shadow-ledge-green outline-none focus-visible:outline-4 focus-visible:outline-yellow"
      >
        <Icon name="plus" className="size-6" />
      </button>
    </li>
  );
}
