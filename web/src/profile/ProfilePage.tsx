// The Profile page (spec #244): what a Profile has sung, from the server's
// Profile stats (`GET /api/profiles/{id}/stats`). One component, opened from
// the Phone (a full-screen sheet from the Me sheet's "My stats" and from a
// Profile on the People tab), the Stage (a layer over the People overlay,
// from a Profile's spot) and Admin › Profiles (inline under each Profile).
// Guests keep no Score records, so they have no Profile page.
//
// It shows the avatar large in the Profile's favourite colour, the headline
// numbers as chunky stat tiles (Songs sung, Rounds, High scores held), the
// best Score per Difficulty, the High scores held with covers and the
// most-sung Songs; a Profile that never sang shows "No Songs sung yet".

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { profileStatsQuery, profilesQuery } from "../api/queries";
import type { Profile } from "../generated/Profile";
import type { ProfileId } from "../generated/ProfileId";
import type { ProfileStats } from "../generated/ProfileStats";
import type { StatsSong } from "../generated/StatsSong";
import { difficultyName } from "../i18n/seatNames";
import { t } from "../i18n/t";
import { tokenVar } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { Cover } from "../ui/Cover";

/**
 * How large it draws: `compact` on the Phone and in Admin, `stage` in the
 * Stage's 1920 × 1080 reference frame, read from across the room.
 */
export type ProfilePageSize = "compact" | "stage";

interface SizeStyle {
  avatar: number;
  name: string;
  since: string;
  tiles: string;
  tile: string;
  tileNumber: string;
  tileLabel: string;
  sections: string;
  sectionTitle: string;
  row: string;
  rowTitle: string;
  rowSub: string;
  rowNumber: string;
  cover: string;
  rim: number;
  message: string;
  /** How many High scores held it lists; the rest are counted. */
  heldShown: number;
}

const SIZES: Record<ProfilePageSize, SizeStyle> = {
  compact: {
    avatar: 96,
    name: "text-3xl",
    since: "text-base",
    tiles: "gap-2.5",
    tile: "rounded-card-sm px-2 py-3 shadow-ledge-sm",
    tileNumber: "text-4xl",
    tileLabel: "text-sm",
    sections: "flex flex-col gap-5",
    sectionTitle: "text-xl",
    row: "min-h-16 gap-3 rounded-card-sm px-3 py-2 shadow-ledge-sm",
    rowTitle: "text-lg",
    rowSub: "text-sm",
    rowNumber: "text-xl",
    cover: "w-12",
    rim: 3,
    message: "text-xl",
    heldShown: Infinity,
  },
  stage: {
    avatar: 200,
    name: "text-7xl",
    since: "text-3xl",
    tiles: "gap-6",
    tile: "rounded-card px-6 py-5 shadow-ledge",
    tileNumber: "text-8xl",
    tileLabel: "text-3xl",
    sections: "grid grid-cols-3 gap-8",
    sectionTitle: "text-3xl",
    row: "h-[92px] gap-4 rounded-card-sm px-4 shadow-ledge-sm",
    rowTitle: "text-[28px]",
    rowSub: "text-xl",
    rowNumber: "text-[32px]",
    cover: "w-16",
    rim: 4,
    message: "text-4xl",
    heldShown: 5,
  },
};

// The catalogue's language, as `t` formats numbers in it.
const DATE = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export interface ProfilePageProps {
  profileId: ProfileId;
  size?: ProfilePageSize;
  /** The name's heading level: 2 where the page stands alone. */
  headingLevel?: 2 | 3;
}

/** The Profile page of `profileId`: its Profile and stats, fetched. */
export function ProfilePage({
  profileId,
  size = "compact",
  headingLevel = 2,
}: ProfilePageProps) {
  const profiles = useQuery(profilesQuery);
  const stats = useQuery(profileStatsQuery(profileId));
  const profile = profiles.data?.find((p) => p.id === profileId);
  const style = SIZES[size];

  if (profiles.data && !profile) {
    return <Message style={style}>{t("profilePage.gone")}</Message>;
  }
  if (profile && stats.data) {
    return (
      <ProfilePageView
        profile={profile}
        stats={stats.data}
        size={size}
        headingLevel={headingLevel}
      />
    );
  }
  return (
    <Message style={style}>
      {t(
        profiles.isError || stats.isError
          ? "profilePage.failed"
          : "profilePage.loading",
      )}
    </Message>
  );
}

function Message({ style, children }: { style: SizeStyle; children: string }) {
  return (
    <p role="status" className={`py-8 text-center text-ink-2 ${style.message}`}>
      {children}
    </p>
  );
}

export interface ProfilePageViewProps {
  profile: Profile;
  stats: ProfileStats;
  size?: ProfilePageSize;
  headingLevel?: 2 | 3;
}

/** The Profile page itself, drawn from a Profile and its stats. */
export function ProfilePageView({
  profile,
  stats,
  size = "compact",
  headingLevel = 2,
}: ProfilePageViewProps) {
  const style = SIZES[size];
  const Name = headingLevel === 2 ? "h2" : "h3";
  const Section = headingLevel === 2 ? "h3" : "h4";
  const sang = stats.songsSung > 0;

  return (
    <div className={`flex flex-col ${size === "stage" ? "gap-8" : "gap-5"}`}>
      <div
        className={`flex items-center ${size === "stage" ? "gap-8" : "gap-4"}`}
      >
        <Avatar
          name={profile.name}
          avatar={profile.avatar}
          colour={profile.favouriteColour}
          size={style.avatar}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <Name
            className={`truncate leading-tight font-bold ${style.name}`}
            style={{ color: tokenVar(profile.favouriteColour) }}
          >
            {profile.name}
          </Name>
          {stats.firstSung ? (
            <span className={`text-ink-2 ${style.since}`}>
              {t("profilePage.since", {
                date: DATE.format(stats.firstSung.at),
              })}
            </span>
          ) : null}
        </div>
      </div>
      {sang ? (
        <>
          <ul
            aria-label={t("profilePage.headline")}
            className={`grid grid-cols-3 ${style.tiles}`}
          >
            <Tile style={style} value={stats.songsSung}>
              {t("profilePage.songsSung")}
            </Tile>
            <Tile style={style} value={stats.rounds}>
              {t("profilePage.rounds")}
            </Tile>
            <Tile style={style} value={stats.highScoresHeld.length}>
              {t("profilePage.highScoresHeld")}
            </Tile>
          </ul>
          <div className={style.sections}>
            <ListSection
              heading={Section}
              title={t("profilePage.bestScores")}
              style={style}
            >
              {stats.bestPerDifficulty.map((best) => (
                <SongRow
                  key={best.difficulty}
                  song={best.song}
                  style={style}
                  lead={difficultyName(best.difficulty)}
                  number={t("profilePage.total", { total: best.total })}
                  sub={DATE.format(best.recordedAt)}
                />
              ))}
            </ListSection>
            <HeldSection heading={Section} stats={stats} style={style} />
            <ListSection
              heading={Section}
              title={t("profilePage.mostSung")}
              style={style}
            >
              {stats.mostSung.map((most, place) => (
                <SongRow
                  key={place}
                  song={most.song}
                  style={style}
                  number={t("profilePage.timesSung", { count: most.rounds })}
                />
              ))}
            </ListSection>
          </div>
        </>
      ) : (
        <Message style={style}>{t("profilePage.empty")}</Message>
      )}
    </div>
  );
}

function Tile({
  style,
  value,
  children,
}: {
  style: SizeStyle;
  value: number;
  children: string;
}) {
  return (
    <li
      className={`flex flex-col items-center bg-white text-center ${style.tile}`}
    >
      <span
        className={`leading-none font-bold tabular-nums ${style.tileNumber}`}
      >
        {t("profilePage.total", { total: value })}
      </span>
      <span className={`mt-1 leading-tight font-semibold ${style.tileLabel}`}>
        {children}
      </span>
    </li>
  );
}

function ListSection({
  heading: Heading,
  title,
  style,
  children,
  after,
}: {
  heading: "h3" | "h4";
  title: string;
  style: SizeStyle;
  children: ReactNode;
  after?: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <Heading className={`font-bold ${style.sectionTitle}`}>{title}</Heading>
      <ul aria-label={title} className="flex flex-col gap-2.5">
        {children}
      </ul>
      {after}
    </section>
  );
}

/** The High scores held, the Stage's first few of them, the rest counted. */
function HeldSection({
  heading,
  stats,
  style,
}: {
  heading: "h3" | "h4";
  stats: ProfileStats;
  style: SizeStyle;
}) {
  const held = stats.highScoresHeld;
  const shown = held.slice(0, style.heldShown);
  const more = held.length - shown.length;
  if (held.length === 0) {
    const Heading = heading;
    return (
      <section className="flex min-w-0 flex-col gap-2.5">
        <Heading className={`font-bold ${style.sectionTitle}`}>
          {t("profilePage.highScoresHeld")}
        </Heading>
        <p className={`text-ink-2 ${style.rowTitle}`}>
          {t("profilePage.noHighScores")}
        </p>
      </section>
    );
  }
  return (
    <ListSection
      heading={heading}
      title={t("profilePage.highScoresHeld")}
      style={style}
      after={
        more > 0 ? (
          <p className={`text-ink-2 ${style.rowSub}`}>
            {t("profilePage.more", { count: more })}
          </p>
        ) : null
      }
    >
      {shown.map((each, place) => (
        <SongRow
          key={place}
          song={each.song}
          style={style}
          lead={
            each.voice > 0
              ? t("profilePage.difficultyVoice", {
                  difficulty: difficultyName(each.difficulty),
                  voice: each.voice + 1,
                })
              : difficultyName(each.difficulty)
          }
          number={t("profilePage.total", { total: each.total })}
        />
      ))}
    </ListSection>
  );
}

/** One Song in a list: its cover, title and artist, and a number. */
function SongRow({
  song,
  style,
  lead,
  number,
  sub,
}: {
  song: StatsSong;
  style: SizeStyle;
  /** Above the title: the Difficulty (and Voice). */
  lead?: string;
  number: string;
  /** Below the artist: a date. */
  sub?: string;
}) {
  return (
    <li className={`flex items-center bg-white ${style.row}`}>
      <Cover
        src={song.cover}
        tileColour={song.tileColour}
        rim={style.rim}
        className={style.cover}
      />
      <span className="flex min-w-0 grow flex-col leading-tight">
        {lead ? (
          <span className={`font-semibold text-ink-2 ${style.rowSub}`}>
            {lead}
          </span>
        ) : null}
        <span className={`truncate font-bold ${style.rowTitle}`}>
          {song.title}
        </span>
        <span className={`truncate text-ink-2 ${style.rowSub}`}>
          {sub
            ? t("profilePage.artistAndDate", { artist: song.artist, date: sub })
            : song.artist}
        </span>
      </span>
      <span
        className={`shrink-0 font-bold whitespace-nowrap tabular-nums ${style.rowNumber}`}
      >
        {number}
      </span>
    </li>
  );
}
