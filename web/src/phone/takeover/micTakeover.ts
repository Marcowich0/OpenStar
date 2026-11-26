// The mic takeover's state (v1 spec #49, "Mic takeover"; ticket #167): a
// pure function of the live store and this Phone's mic. While this Phone is
// the Mic of a seat in the Line-up the Phone page is the takeover, in the
// seated Player's Party colour (who need not be this Phone's own member).
//
// Steps: Seated (the mic is off: "Turn on my mic", also once the Song has
// started without it), opening, Mic is on (before Start; a mic kept open from
// the previous Song comes straight here), Singing (after Start), mic blocked
// and mic lost. The After the Song screen is #176's: while the results show
// there is no Line-up, so the takeover is `null` and the Remote's Stage tab
// shows them (the mic stays open through them, `micRole` "between").

import type { MicBlockedReason, PhoneMicSnapshot } from "../mic/phoneMic";
import type { PaletteKey } from "../../generated/PaletteKey";
import type { PartyMemberId } from "../../generated/PartyMemberId";
import type { PhoneId } from "../../generated/PhoneId";
import type { RequestId } from "../../generated/RequestId";
import type { Seat } from "../../generated/Seat";
import type { SongId } from "../../generated/SongId";
import type { LiveState } from "../../live/liveState";

export type TakeoverStep =
  "seated" | "opening" | "micOn" | "singing" | "blocked" | "lost";

export interface MicTakeover {
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

/** Whether the Phone `phoneId` is the Mic of a seat in the Line-up. */
export function isSeatedMic(state: LiveState, phoneId: PhoneId): boolean {
  return (
    state.stage?.party?.lineUp?.seats.some(
      (seat) => seat.mic?.kind === "phone" && seat.mic.phoneId === phoneId,
    ) ?? false
  );
}

export function micTakeover(
  state: LiveState,
  phoneId: PhoneId,
  mic: Pick<PhoneMicSnapshot, "state" | "blocked">,
): MicTakeover | null {
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
      return "lost";
  }
}

/** The sung level, 0 to 1, from a reading's loudness in dBFS. */
export function levelOf(loudnessDbfs: number): number {
  const QUIET = -60;
  const LOUD = -12;
  return Math.min(1, Math.max(0, (loudnessDbfs - QUIET) / (LOUD - QUIET)));
}
