import { describe, expect, it } from "vitest";

import type { SongFilters } from "../../generated/SongFilters";
import {
  chipActive,
  filterChips,
  noFilter,
  songListQuery,
  toggleChip,
} from "./songChips";

const filters: SongFilters = {
  languages: ["English", "German"],
  genres: ["Pop", "Rock"],
  years: [1983, 2006],
  editions: ["SingStar"],
  creators: ["someone"],
  duet: [false, true],
  hasVideo: [false, true],
  length: { minSeconds: 120, maxSeconds: 300 },
};

describe("the filter chips", () => {
  it("offer Duets, With video, then every language, genre, year (newest first) and edition", () => {
    expect(filterChips(filters)).toEqual([
      { field: "duet", value: true },
      { field: "hasVideo", value: true },
      { field: "language", value: "English" },
      { field: "language", value: "German" },
      { field: "genre", value: "Pop" },
      { field: "genre", value: "Rock" },
      { field: "year", value: 2006 },
      { field: "year", value: 1983 },
      { field: "edition", value: "SingStar" },
    ]);
  });

  it("leave out Duets and With video when no Song is one", () => {
    expect(
      filterChips({
        ...filters,
        duet: [false],
        hasVideo: [],
        languages: [],
        genres: [],
        years: [],
        editions: [],
      }),
    ).toEqual([]);
  });

  it("toggle a filter on and off, one value per field", () => {
    const pop = { field: "genre", value: "Pop" } as const;
    const rock = { field: "genre", value: "Rock" } as const;
    const duets = { field: "duet", value: true } as const;

    let query = toggleChip({}, pop);
    expect(query).toEqual({ genre: "Pop" });
    expect(chipActive(query, pop)).toBe(true);
    expect(noFilter(query)).toBe(false);

    query = toggleChip(query, rock);
    expect(query).toEqual({ genre: "Rock" });
    expect(chipActive(query, pop)).toBe(false);

    query = toggleChip(query, duets);
    expect(query).toEqual({ genre: "Rock", duet: true });

    query = toggleChip(toggleChip(query, rock), duets);
    expect(query).toEqual({});
    expect(noFilter(query)).toBe(true);
  });

  it("send the search only when it has text, trimmed", () => {
    expect(songListQuery({ year: 2006 }, "  ")).toEqual({ year: 2006 });
    expect(songListQuery({}, " valerie ")).toEqual({ search: "valerie" });
  });
});
