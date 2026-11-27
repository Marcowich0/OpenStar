// The Line-up's header (v1 spec #55, #247): the head's cover, title and
// artist, centred over the seats while they fit. It never reaches into the
// chrome's corners (`frame/chromeLanes.ts`): a three-column grid whose side
// columns are at least the back pill's and the Stage menu's lanes and share
// what is left equally, so a short title stays centred, a longer one moves
// over as far as it must, and one longer still shortens with "…" on one line
// (title and artist each). The full text stays in the page, so it is the
// heading's accessible name, and `title` shows it on hover.

import type { SongSummary } from "../../../generated/SongSummary";
import { t } from "../../../i18n/t";
import { Cover } from "../../../ui/Cover";
import { CHROME_LEFT_LANE, CHROME_RIGHT_LANE } from "../../frame/chromeLanes";

const COLUMNS = `minmax(${String(CHROME_LEFT_LANE)}px, 1fr) minmax(0, auto) minmax(${String(CHROME_RIGHT_LANE)}px, 1fr)`;

export function LineUpHeader({
  song,
  duet,
}: {
  /** The head's Song, `undefined` until the Library list has loaded. */
  song: SongSummary | undefined;
  duet: boolean;
}) {
  const artist =
    song && duet
      ? t("stage.lineUp.artistDuet", { artist: song.artist })
      : song?.artist;
  return (
    <header
      data-testid="line-up-header"
      className="mt-14 grid w-full"
      style={{ gridTemplateColumns: COLUMNS }}
    >
      <div className="col-start-2 flex min-w-0 items-center gap-[26px]">
        <Cover
          src={song?.cover ?? null}
          song={song ?? null}
          rim={7}
          className="w-[120px]"
        />
        <div className="min-w-0">
          {/* The padding keeps the descenders inside the clipped box. */}
          <h1
            title={song?.title}
            className="-mb-[0.12em] truncate pb-[0.12em] text-[72px] leading-none font-bold"
          >
            {song?.title}
          </h1>
          <p
            title={artist}
            className="mt-1.5 truncate text-[32px] font-medium text-ink-2"
          >
            {artist}
          </p>
        </div>
      </div>
    </header>
  );
}
