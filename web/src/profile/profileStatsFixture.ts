// A Profile and its stats, as `GET /api/profiles/{id}/stats` answers them,
// for the Profile page's tests. Tests only.

import type { Profile } from "../generated/Profile";
import type { ProfileStats } from "../generated/ProfileStats";
import type { StatsSong } from "../generated/StatsSong";

export const PROFILE_ADA: Profile = {
  id: 7,
  name: "Ada",
  avatar: { kind: "builtIn", key: "rocket" },
  favouriteColour: "berry",
  lastDifficulty: "medium",
  createdAt: 0,
  lastSungAt: Date.UTC(2024, 2, 14, 12),
};

const AFRICA: StatsSong = {
  id: 3,
  artist: "Toto",
  title: "Africa",
  cover: "/api/songs/3/cover",
  tileColour: "teal",
};

const VALERIE: StatsSong = {
  id: 4,
  artist: "Amy Winehouse",
  title: "Valerie",
  cover: "/api/songs/4/cover",
  tileColour: "sky",
};

/** A duet that has left the Library: no id, no cover. */
const GONE_DUET: StatsSong = {
  id: null,
  artist: "Elton John & Kiki Dee",
  title: "Don't Go Breaking My Heart",
  cover: null,
  tileColour: "grape",
};

export const STATS_ADA: ProfileStats = {
  songsSung: 12,
  rounds: 31,
  finishedRounds: 29,
  bestPerDifficulty: [
    {
      difficulty: "medium",
      total: 8120,
      song: AFRICA,
      recordedAt: Date.UTC(2024, 0, 5, 12),
    },
    {
      difficulty: "hard",
      total: 9400,
      song: VALERIE,
      recordedAt: Date.UTC(2024, 2, 14, 12),
    },
  ],
  highScoresHeld: [
    { song: VALERIE, voice: 0, difficulty: "hard", total: 9400 },
    { song: GONE_DUET, voice: 1, difficulty: "medium", total: 7010 },
  ],
  mostSung: [
    { song: AFRICA, rounds: 7 },
    { song: VALERIE, rounds: 1 },
  ],
  firstSung: { song: AFRICA, at: Date.UTC(2023, 10, 2, 12) },
  lastSung: { song: VALERIE, at: Date.UTC(2024, 2, 14, 12) },
};

/** A Profile that has not sung yet. */
export const NO_STATS: ProfileStats = {
  songsSung: 0,
  rounds: 0,
  finishedRounds: 0,
  bestPerDifficulty: [],
  highScoresHeld: [],
  mostSung: [],
  firstSung: null,
  lastSung: null,
};
