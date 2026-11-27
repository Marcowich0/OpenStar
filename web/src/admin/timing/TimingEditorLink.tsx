// A Song's way into its Timing editor, among the Song's actions in the Songs
// section. The editor is a desktop view: the Songs section shows the link
// only with a fine pointer and room for it (`useFullTimingEditor`); any other
// browser gets Fit to the singing instead (#223).

import { Link } from "@tanstack/react-router";

import type { SongSummary } from "../../generated/SongSummary";
import { t } from "../../i18n/t";

export function TimingEditorLink({ song }: { song: SongSummary }) {
  return (
    <Link
      to="/admin/songs/$song/timing"
      params={{ song: song.id }}
      aria-label={t("admin.songs.timingOf", { title: song.title })}
      className="rounded-full bg-white px-4 py-1.5 text-lg font-semibold text-ink shadow-ledge-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow"
    >
      {t("admin.songs.timing")}
    </Link>
  );
}
