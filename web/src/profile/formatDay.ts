// The day a Profile's stats name, in the catalogue's language (as `t`
// formats numbers in it): the Profile page's "Singing since" and a Best
// Score's day, and Admin › Profiles' "Last sung".

const DAY = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/** The day of `ms` (ms since the epoch), as "Nov 27, 2026". */
export function formatDay(ms: number): string {
  return DAY.format(ms);
}
