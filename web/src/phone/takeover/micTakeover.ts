// The mic takeover's state (v1 spec #49, "Mic takeover"; ticket #167): a
// pure function of the live store and this Phone's mic. While this Phone is
// the Mic of a seat in the Line-up the Phone page is the takeover, in the
// seated Player's Party colour (who need not be this Phone's own member).
//
// Steps: Seated (the mic is off: "Turn on my mic", also once the Song has
// started without it), opening, Mic is on (before Start; a mic kept open from
// the previous Song comes straight here), Singing (after Start), mic blocked
// and mic lost (#176). After the Song (#176): while the Stage shows the
// results of a Song this Phone was a Player's Mic for, the takeover shows that
// Player's own result until Done, whatever the mic did meanwhile, so a Phone
// back after the Song shows it too; once the Stage leaves the results (or
// after Done) the Remote returns. The mic stays open through the results
// (`micRole` "between").

import type { MicBlockedReason, PhoneMicSnapshot } from "../mic/phoneMic";
import { myResult } from "../stage/myResult";
import type { PaletteKey } from "../../generated/PaletteKey";
import type { PartyMemberId } from "../../generated/PartyMemberId";
import type { PhoneId } from "../../generated/PhoneId";
import type { PlayerResult } from "../../generated/PlayerResult";
import type { RequestId } from "../../generated/RequestId";
import type { Seat } from "../../generated/Seat";
import type { SongId } from "../../generated/SongId";
import type { LiveState } from "../../live/liveState";

export type TakeoverStep =
  "seated" | "opening" | "micOn" | "singing" | "blocked" | "lost";

export type MicTakeover = SeatTakeover | AfterTheSong;

/** While this Phone is the Mic of a seat in the Line-up. */
export interface SeatTakeover {
  step: TakeoverStep;
  /** The seat this Phone is the Mic of, and its index in the Line-up. */
  seat: Seat;
  seatIndex: number;
  /** The seated Player. */
  memberId: PartyMemberId;
  /** The seated Player's Party colour, the takeover's background. */
  colour: PaletteKey;
  /** Whether the Song is a duet: the Voice chip shows only then. */
  duet: boolean;
  requestId: RequestId;
  songId: SongId;
  /** The Line-up's Start is allowed (the server's `canStart`). */
  canStart: boolean;
  /** The Song has started: the Difficulty is locked. */
  started: boolean;
  /** The seat's running total at its last Line end, or `null` before one. */
  score: number | null;
  /** Why the mic could not open, exactly while `blocked`. */
  blocked: MicBlockedReason | null;
}

/** The After the Song screen: the Player's own result, until Done. */
export interface AfterTheSong {
  step: "after";
  /** The Request sung: Done is remembered for it. */
  requestId: RequestId;
  songId: SongId;
  memberId: PartyMemberId;
  colour: PaletteKey;
  result: PlayerResult;
}

/** Whether the Phone `phoneId` is the Mic of a seat in the Line-up. */
export function isSeatedMic(state: LiveState, phoneId: PhoneId): boolean {
  return (
    state.stage?.party?.lineUp?.seats.some(
      (seat) => seat.mic?.kind === "phone" && seat.mic.phoneId === phoneId,
    ) ?? false
  );
}

/**
 * Whether the Phone page is the takeover: this Phone is a seat's Mic, or the
 * Stage shows the results of a Song it was a Player's Mic for and Done was
 * not tapped for that Request (`done`).
 */
export function takeoverShows(
  state: LiveState,
  phoneId: PhoneId,
  done: RequestId | null,
): boolean {
  return (
    isSeatedMic(state, phoneId) || afterTheSong(state, phoneId, done) !== null
  );
}

function afterTheSong(
  state: LiveState,
  phoneId: PhoneId,
  done: RequestId | null,
): AfterTheSong | null {
  const results = state.stage?.party?.results ?? null;
  if (!results || results.requestId === done) return null;
  const result = myResult(results, phoneId);
  if (!result) return null;
  return {
    step: "after",
    requestId: results.requestId,
    songId: results.songId,
    memberId: result.memberId,
    colour: result.colour,
    result,
  };
}

/**
 * The takeover for this Phone, or `null` while the Remote shows. `done` is
 * the Request whose After the Song screen was closed with Done.
 */
export function micTakeover(
  state: LiveState,
  phoneId: PhoneId,
  mic: Pick<PhoneMicSnapshot, "state" | "blocked">,
  done: RequestId | null = null,
): MicTakeover | null {
  const after = afterTheSong(state, phoneId, done);
  if (after) return after;
  const party = state.stage?.party;
  const lineUp = party?.lineUp;
  if (!party || !lineUp) return null;
  const seatIndex = lineUp.seats.findIndex(
    (s) => s.mic?.kind === "phone" && s.mic.phoneId === phoneId,
  );
  const seat = lineUp.seats[seatIndex];
  if (!seat) return null;
  const member = party.members.find((m) => m.memberId === seat.memberId);
  const playing =
    party.playing?.requestId === lineUp.requestId ? party.playing : null;
  const songId =
    playing?.songId ??
    party.queue.find((r) => r.requestId === lineUp.requestId)?.songId;
  if (!member || songId === undefined) return null;
  const started = playing !== null;
  const score =
    state.lineScore?.requestId === lineUp.requestId
      ? state.lineScore.total
      : null;
  return {
    step: step(mic.state, started),
    seat,
    seatIndex,
    memberId: seat.memberId,
    colour: member.colour,
    duet: lineUp.duet,
    requestId: lineUp.requestId,
    songId,
    canStart: lineUp.canStart,
    started,
    score,
    blocked: mic.state === "failed" ? mic.blocked : null,
  };
}

function step(mic: PhoneMicSnapshot["state"], started: boolean): TakeoverStep {
  switch (mic) {
    case "off":
      return "seated";
    case "opening":
      return "opening";
    case "on":
      return started ? "singing" : "micOn";
    case "failed":
      return "blocked";
    case "lost":
      // Before Start the Song has not kept going: turn the mic back on.
      return started ? "lost" : "seated";
  }
}

/** The sung level, 0 to 1, from a reading's loudness in dBFS. */
export function levelOf(loudnessDbfs: number): number {
  const QUIET = -60;
  const LOUD = -12;
  return Math.min(1, Math.max(0, (loudnessDbfs - QUIET) / (LOUD - QUIET)));
}
