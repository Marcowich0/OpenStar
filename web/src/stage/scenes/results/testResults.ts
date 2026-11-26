// Fixture results for the results screen's tests and its screenshots.

import type { PlayerResult } from "../../../generated/PlayerResult";
import type { SongResults } from "../../../generated/SongResults";

export const playerResult = (over: Partial<PlayerResult>): PlayerResult => ({
  memberId: 1,
  player: { kind: "profile", profileId: 1 },
  name: "Bo",
  avatar: { kind: "builtIn", key: "cat" },
  colour: "cherry",
  mic: null,
  voice: null,
  difficulty: "medium",
  total: 0,
  notes: 0,
  golden: 0,
  lineBonus: 0,
  place: 1,
  rankTitleBand: 0,
  newHighScore: false,
  micLost: false,
  unfinished: false,
  ...over,
});

export const songResults = (
  players: PlayerResult[],
  over: Partial<SongResults> = {},
): SongResults => ({
  requestId: 1,
  songId: 10,
  ended: "played",
  players,
  ...over,
});
