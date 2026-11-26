// The outcome of a Song that played out or was ended, as the Stage sends it
// (`POST /api/rounds`, #175): one Score per seat of the Line-up fixed at
// Start, in seat order, built from the live scoring's outcome and each
// seat's Party member.

import type { PartyMemberId } from "../../../generated/PartyMemberId";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { PlayerScore } from "../../../generated/PlayerScore";
import type { RequestId } from "../../../generated/RequestId";
import type { RoundOutcome } from "../../../generated/RoundOutcome";
import type { ScorePlayer } from "../../../generated/ScorePlayer";
import type { SongId } from "../../../generated/SongId";
import type { LiveScoringOutcome } from "../../../scoring/liveScoring";

export interface RoundOutcomeInput {
  requestId: RequestId;
  songId: SongId;
  /** The Party as it was at Start. */
  party: PartySnapshot;
  /** Each seat's member, in seat order (`SingSetup.players`). */
  memberIds: readonly PartyMemberId[];
  /** The live scoring's outcome, in the same order. */
  scoring: LiveScoringOutcome;
  startedAtMs: number;
  ended: "played" | "ended";
}

/** The outcome, or `null` when a seat's member cannot be named. */
export function roundOutcome(input: RoundOutcomeInput): RoundOutcome | null {
  const scores: PlayerScore[] = [];
  for (const [i, outcome] of input.scoring.players.entries()) {
    const member = input.party.members.find(
      (m) => m.memberId === input.memberIds[i],
    );
    if (!member) return null;
    const player: ScorePlayer =
      member.identity.kind === "profile"
        ? { kind: "profile", profileId: member.identity.profileId }
        : { kind: "guest", name: member.identity.name };
    scores.push({
      player,
      voice: outcome.voice,
      difficulty: outcome.difficulty,
      total: outcome.score.total,
      notes: outcome.score.notes,
      golden: outcome.score.golden,
      lineBonus: outcome.score.lineBonus,
      micKind: outcome.micKind,
      unfinished: !outcome.finished,
      micLost: outcome.micLost,
      beatRange: outcome.beatRange,
      beatValues: outcome.beatValues,
    });
  }
  return {
    songId: input.songId,
    requestId: input.requestId,
    noteFingerprint: input.scoring.noteFingerprint,
    partyId: input.party.partyId,
    mode: "normal",
    startedAtMs: input.startedAtMs,
    ended: input.ended,
    scores,
  };
}
