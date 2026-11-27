// The sing screen's pause hint (#264): "Space: pause" under the title card,
// only on the first Song since the Party started.
//
// The Party snapshot does not count the Songs sung, so the Stage remembers
// which Request was the Party's first to start. It keeps that in
// `sessionStorage`, so a Stage reload mid-Party does not show the hint again;
// without storage (blocked, private window) it remembers in memory only.

import type { PartyId } from "../../../generated/PartyId";
import type { RequestId } from "../../../generated/RequestId";

/** Which input the hint names: the key, or the pad's button. */
export type PauseHintInput = "keyboard" | "gamepad";

/**
 * The input the pause hint names. Always the keyboard for now: the gamepad
 * ticket (#275) tracks the last input device and wires it here, so the hint
 * then reads "Start: pause" after pad input.
 */
export function pauseHintInput(): PauseHintInput {
  return "keyboard";
}

export interface FirstSongMemory {
  /**
   * Whether `requestId` is the first Request to start in Party `partyId`.
   * The first call for a Party claims it; asking again for that Request
   * (a re-render, a Restart) still says yes.
   */
  isFirstSong: (partyId: PartyId, requestId: RequestId) => boolean;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

interface FirstSong {
  partyId: PartyId;
  requestId: RequestId;
}

const KEY = "openstar.firstSong";

function read(storage: Storage | null): FirstSong | null {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "partyId" in value &&
      "requestId" in value &&
      typeof value.partyId === "string" &&
      typeof value.requestId === "number"
    ) {
      return { partyId: value.partyId, requestId: value.requestId };
    }
  } catch {
    // Blocked or junk: as if nothing was kept.
  }
  return null;
}

/** The Stage's memory of each Party's first Song, kept in `storage`. */
export function createFirstSongMemory(
  storage: Storage | null,
): FirstSongMemory {
  let first = read(storage);
  return {
    isFirstSong: (partyId, requestId) => {
      if (first?.partyId !== partyId) {
        first = { partyId, requestId };
        try {
          storage?.setItem(KEY, JSON.stringify(first));
        } catch {
          // Kept in memory only.
        }
      }
      return first.requestId === requestId;
    },
  };
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

let stageMemory: FirstSongMemory | null = null;

/** The Stage browser's one memory, in its `sessionStorage`. */
export function stageFirstSongMemory(): FirstSongMemory {
  stageMemory ??= createFirstSongMemory(sessionStore());
  return stageMemory;
}
