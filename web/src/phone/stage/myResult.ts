// The result a Phone shows after a Song (#175): its own Player's, the one
// whose seat it was the Mic of. Every Phone receives the whole results with
// the Party; this picks its own.

import type { PhoneId } from "../../generated/PhoneId";
import type { PlayerResult } from "../../generated/PlayerResult";
import type { SongResults } from "../../generated/SongResults";

export function myResult(
  results: SongResults | null,
  myPhoneId: PhoneId,
): PlayerResult | null {
  return (
    results?.players.find(
      (player) =>
        player.mic?.kind === "phone" && player.mic.phoneId === myPhoneId,
    ) ?? null
  );
}
