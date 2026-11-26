// The song browser's search (v1 spec #55, "Song browser and join card"): the
// typed words and the filter chips, held by the frame so the song browser and
// the Songs overlay narrow the same carousel. Matching is the server's
// (`GET /api/songs`, the Library index's search and filter fields), as on the
// Remote's Songs tab.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useDeferredValue,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { songsQuery } from "../../api/queries";
import type { SongFilters } from "../../generated/SongFilters";
import type { SongSummary } from "../../generated/SongSummary";
import {
  songListQuery,
  toggleChip,
  type FilterChip,
  type SongFilterQuery,
} from "../../phone/songs/songChips";

export interface SongSearch {
  /** The search box is open. */
  open: boolean;
  text: string;
  filters: SongFilterQuery;
  openBox: () => void;
  setText: (text: string) => void;
  toggle: (chip: FilterChip) => void;
  /** The "All" chip: every filter off. */
  clearFilters: () => void;
  /** Esc: clears the words and the filters and closes the box. */
  close: () => void;
}

const SearchContext = createContext<SongSearch | null>(null);

export function SongSearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [filters, setFilters] = useState<SongFilterQuery>({});
  const search = useMemo<SongSearch>(
    () => ({
      open,
      text,
      filters,
      openBox: () => {
        setOpen(true);
      },
      setText,
      toggle: (chip) => {
        setFilters((current) => toggleChip(current, chip));
      },
      clearFilters: () => {
        setFilters({});
      },
      close: () => {
        setOpen(false);
        setText("");
        setFilters({});
      },
    }),
    [open, text, filters],
  );
  return <SearchContext value={search}>{children}</SearchContext>;
}

export function useSongSearch(): SongSearch {
  const search = useContext(SearchContext);
  if (!search) throw new Error("used outside the StageFrame");
  return search;
}

export interface StageSongs {
  /** The Songs the search lets through; `undefined` while loading. */
  songs: readonly SongSummary[] | undefined;
  /** The filter fields' values over the whole Library, for the chips. */
  filters: SongFilters | undefined;
  /** A search or filter is on, so an empty list means "no match". */
  narrowed: boolean;
}

/** The carousel's Songs, narrowed by the search. */
export function useStageSongs(): StageSongs {
  const { text, filters } = useSongSearch();
  const query = songListQuery(filters, useDeferredValue(text));
  const list = useQuery({
    ...songsQuery(query),
    placeholderData: keepPreviousData,
  });
  return {
    songs: list.data?.songs,
    filters: list.data?.filters,
    narrowed: Object.keys(query).length > 0,
  };
}
