// The Songs tab's filter chips (v1 spec #49, "Songs tab and the Request
// sheet"): one chip per value of the Library index's filter fields
// (`SongFilters`), each sent as a field of `GET /api/songs`' `SongQuery`.
// A field takes one value, so a chip replaces another of its field; chips
// of different fields combine. Creators and lengths have no chip: they
// help the Admin area more than a Party.

import type { SongFilters } from "../../generated/SongFilters";
import type { SongQuery } from "../../generated/SongQuery";
import { t } from "../../i18n/t";

/** The filter part of a `SongQuery`: everything but the search text. */
export type SongFilterQuery = Omit<SongQuery, "search">;

export type FilterChip =
  | { field: "duet"; value: true }
  | { field: "hasVideo"; value: true }
  | { field: "language" | "genre" | "edition"; value: string }
  | { field: "year"; value: number };

/** The chips for the values the Library has, in the order they show. */
export function filterChips(filters: SongFilters): FilterChip[] {
  const text = (field: "language" | "genre" | "edition", values: string[]) =>
    values.map((value): FilterChip => ({ field, value }));
  return [
    ...(filters.duet.includes(true)
      ? [{ field: "duet", value: true } as const]
      : []),
    ...(filters.hasVideo.includes(true)
      ? [{ field: "hasVideo", value: true } as const]
      : []),
    ...text("language", filters.languages),
    ...text("genre", filters.genres),
    ...[...filters.years]
      .reverse()
      .map((value): FilterChip => ({ field: "year", value })),
    ...text("edition", filters.editions),
  ];
}

export function chipActive(query: SongFilterQuery, chip: FilterChip): boolean {
  return query[chip.field] === chip.value;
}

/** Turns a chip on (replacing its field's value), or off when it was on. */
export function toggleChip(
  query: SongFilterQuery,
  chip: FilterChip,
): SongFilterQuery {
  const { [chip.field]: current, ...rest } = query;
  return current === chip.value ? rest : { ...rest, [chip.field]: chip.value };
}

/** No filter is on: the "All" chip is. */
export function noFilter(query: SongFilterQuery): boolean {
  return Object.keys(query).length === 0;
}

/** The query `GET /api/songs` gets: the filters and the search, if any. */
export function songListQuery(
  filters: SongFilterQuery,
  search: string,
): SongQuery {
  const words = search.trim();
  return words === "" ? filters : { ...filters, search: words };
}

/** What a chip says. */
export function chipLabel(chip: FilterChip): string {
  switch (chip.field) {
    case "duet":
      return t("songs.duets");
    case "hasVideo":
      return t("songs.withVideo");
    case "year":
      return String(chip.value);
    case "language":
    case "genre":
    case "edition":
      return chip.value;
  }
}
