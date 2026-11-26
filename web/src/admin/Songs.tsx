// The Admin area's Songs section (v1 spec #46): every playable Song (cover,
// title, artist) with a search box over artist and title, on the Library
// index's search (`GET /api/songs?search=`). It refreshes from the `library`
// change notice, like every Song list. Each row is where the Song's admin
// actions attach: Restore Original (#188), Delete (#190), the Timing editor
// (#218) and Fit to the singing (#223), passed as the row's `children`.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState, type ReactNode } from "react";
import { Input, SearchField } from "react-aria-components";

import { songsQuery } from "../api/queries";
import type { SongQuery } from "../generated/SongQuery";
import type { SongSummary } from "../generated/SongSummary";
import { t } from "../i18n/t";
import { Cover } from "../ui/Cover";
import { Icon } from "../ui/Icon";
import { AdminSection } from "./AdminSection";

function searchQuery(search: string): SongQuery {
  const words = search.trim();
  return words === "" ? {} : { search: words };
}

export function Songs() {
  const [search, setSearch] = useState("");
  const query = searchQuery(useDeferredValue(search));
  const list = useQuery({
    ...songsQuery(query),
    placeholderData: keepPreviousData,
  });

  return (
    <AdminSection title={t("admin.songs")} writesLibrary>
      <div className="flex flex-col gap-4">
        <SearchField
          aria-label={t("admin.songs.search")}
          value={search}
          onChange={setSearch}
          className="flex h-13 items-center gap-2.5 rounded-full bg-white px-4.5 ring-2 ring-ledge"
        >
          <Icon name="search" className="size-5.5 shrink-0 text-ink-2" />
          <Input
            placeholder={t("admin.songs.search")}
            autoComplete="off"
            className="min-w-0 grow bg-transparent text-lg text-ink outline-none placeholder:text-mute [&::-webkit-search-cancel-button]:hidden"
          />
        </SearchField>

        {list.data ? (
          list.data.songs.length === 0 ? (
            <p className="py-4 text-center">
              {t(
                query.search === undefined
                  ? "admin.songs.empty"
                  : "admin.songs.none",
              )}
            </p>
          ) : (
            <ul
              aria-label={t("admin.songs.list")}
              className="flex flex-col gap-3"
            >
              {list.data.songs.map((song) => (
                <AdminSongRow key={song.id} song={song} />
              ))}
            </ul>
          )
        ) : (
          <p role="status" className="py-4 text-center">
            {t(list.isError ? "admin.songs.failed" : "admin.songs.loading")}
          </p>
        )}
      </div>
    </AdminSection>
  );
}

export interface AdminSongRowProps {
  song: SongSummary;
  /** The Song's admin actions, at the row's end (later tickets). */
  children?: ReactNode;
}

/** One Song in the Songs section: its cover, title and artist, and its actions. */
export function AdminSongRow({ song, children }: AdminSongRowProps) {
  return (
    <li className="flex min-w-0 items-center gap-3">
      <Cover
        src={song.cover}
        tileColour={song.tileColour}
        rim={3}
        className="w-14 shrink-0"
      />
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <span className="truncate text-lg leading-tight font-semibold text-ink">
          {song.title}
        </span>
        <span className="truncate text-sm text-ink-2">{song.artist}</span>
      </div>
      {children === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      )}
    </li>
  );
}
