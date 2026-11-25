// What a Stage toast says and whose avatar it carries (v1 spec #55,
// "Toasts"). The server sends a code plus parameters; the actor's name and
// look come from the Party snapshot (a Guest) or the Profiles (a Profile),
// and the text from the catalogue through `tParts`, so names and Song titles
// can be set in bold. No English comes from the server.

import type { Avatar } from "../../generated/Avatar";
import type { PartyMemberId } from "../../generated/PartyMemberId";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { Profile } from "../../generated/Profile";
import type { RequestChange } from "../../generated/RequestChange";
import { colourName } from "../../i18n/colourNames";
import { difficultyName, voiceNumber } from "../../i18n/seatNames";
import { tParts, type TextPart } from "../../i18n/t";
import type { Toast } from "../../live/toasts";
import type { PaletteKey } from "../../theme/tokens";

/** The Party member a toast is about: drawn as its avatar at the left. */
export interface ToastActor {
  name: string;
  avatar: Avatar;
  colour: PaletteKey;
}

export interface ToastContent {
  /** `null` for a change the Stage made, or a member not known (yet). */
  actor: ToastActor | null;
  parts: TextPart[];
}

/** The parameters set in bold: names and Song titles. */
export const BOLD_PARAMS: ReadonlySet<string> = new Set([
  "actor",
  "name",
  "song",
]);

/** A Party member's name, avatar and Party colour, if they are known. */
export function memberLook(
  party: PartySnapshot | null,
  profiles: readonly Profile[],
  memberId: PartyMemberId,
): ToastActor | null {
  const member = party?.members.find((m) => m.memberId === memberId);
  if (!member) return null;
  const { identity } = member;
  if (identity.kind === "guest") {
    return {
      name: identity.name,
      avatar: identity.avatar,
      colour: member.colour,
    };
  }
  const profile = profiles.find((p) => p.id === identity.profileId);
  return profile
    ? { name: profile.name, avatar: profile.avatar, colour: member.colour }
    : null;
}

/** A Queue change: "Bo moved Africa up", or without the actor while unknown. */
function queueChange(
  actor: ToastActor | null,
  params: RequestChange,
  withActor: (actor: string, song: string) => TextPart[],
  withoutActor: (song: string) => TextPart[],
): ToastContent {
  return actor
    ? { actor, parts: withActor(actor.name, params.title) }
    : { actor: null, parts: withoutActor(params.title) };
}

export function toastContent(
  toast: Toast,
  party: PartySnapshot | null,
  profiles: readonly Profile[],
): ToastContent {
  const actor =
    toast.actor.kind === "member"
      ? memberLook(party, profiles, toast.actor.memberId)
      : null;
  const { event } = toast;
  switch (event.code) {
    case "partyStarted":
      return { actor, parts: tParts("partyEvent.partyStarted", event.params) };
    case "memberJoined":
      return {
        actor: memberLook(party, profiles, event.params.memberId),
        parts: tParts("partyEvent.memberJoined", {
          name: event.params.name,
          colour: colourName(event.params.colour),
        }),
      };
    case "phoneJoined":
      return {
        actor: memberLook(party, profiles, event.params.memberId),
        parts: tParts("partyEvent.phoneJoined", { name: event.params.name }),
      };
    case "memberChanged":
      return {
        actor: memberLook(party, profiles, event.params.memberId),
        parts: tParts("partyEvent.memberChanged", { name: event.params.name }),
      };
    case "memberLeft": {
      // The member is gone from the snapshot, so its look comes with the event.
      const { name, avatar, colour } = event.params;
      return {
        actor: { name, avatar, colour },
        parts: tParts("toast.memberLeft", {
          actor: name,
          colour: colourName(colour),
        }),
      };
    }
    case "micBlocked":
      return {
        actor: memberLook(party, profiles, event.params.memberId),
        parts: tParts("partyEvent.micBlocked", { name: event.params.name }),
      };
    case "micOpened":
      return {
        actor: memberLook(party, profiles, event.params.memberId),
        parts: tParts("partyEvent.micOpened", { name: event.params.name }),
      };
    case "requestAdded":
      return queueChange(
        actor,
        event.params,
        (name, song) => tParts("toast.requestAdded", { actor: name, song }),
        (song) => tParts("partyEvent.requestAdded", { song }),
      );
    case "requestMovedUp":
      return queueChange(
        actor,
        event.params,
        (name, song) => tParts("toast.requestMovedUp", { actor: name, song }),
        (song) => tParts("partyEvent.requestMovedUp", { song }),
      );
    case "requestMovedDown":
      return queueChange(
        actor,
        event.params,
        (name, song) => tParts("toast.requestMovedDown", { actor: name, song }),
        (song) => tParts("partyEvent.requestMovedDown", { song }),
      );
    case "requestPlayNext":
      return queueChange(
        actor,
        event.params,
        (name, song) => tParts("toast.requestPlayNext", { actor: name, song }),
        (song) => tParts("partyEvent.requestPlayNext", { song }),
      );
    case "requestRemoved":
      return queueChange(
        actor,
        event.params,
        (name, song) => tParts("toast.requestRemoved", { actor: name, song }),
        (song) => tParts("partyEvent.requestRemoved", { song }),
      );
    case "requestedPlayersChanged":
      return queueChange(
        actor,
        event.params,
        (name, song) =>
          tParts("toast.requestedPlayersChanged", { actor: name, song }),
        (song) => tParts("partyEvent.requestedPlayersChanged", { song }),
      );
    case "lineUpChanged":
      return actor
        ? { actor, parts: tParts("toast.lineUpChanged", { actor: actor.name }) }
        : { actor, parts: tParts("partyEvent.lineUpChanged") };
    case "seatMoved": {
      const { name } = event.params;
      return actor
        ? {
            actor,
            parts: tParts("toast.seatMoved", { actor: actor.name, name }),
          }
        : { actor, parts: tParts("partyEvent.seatMoved", { name }) };
    }
    case "seatVoice": {
      const { name } = event.params;
      const voice = voiceNumber(event.params.voice);
      return actor
        ? {
            actor,
            parts: tParts("toast.seatVoice", {
              actor: actor.name,
              name,
              voice,
            }),
          }
        : { actor, parts: tParts("partyEvent.seatVoice", { name, voice }) };
    }
    case "seatDifficulty": {
      const { name } = event.params;
      const difficulty = difficultyName(event.params.difficulty);
      return actor
        ? {
            actor,
            parts: tParts("toast.seatDifficulty", {
              actor: actor.name,
              name,
              difficulty,
            }),
          }
        : {
            actor,
            parts: tParts("partyEvent.seatDifficulty", { name, difficulty }),
          };
    }
    case "nextDifficulty":
      // Only a Player's own Phone sends it, so the actor is the member.
      return {
        actor: memberLook(party, profiles, event.params.memberId),
        parts: tParts("partyEvent.nextDifficulty", {
          name: event.params.name,
          difficulty: difficultyName(event.params.difficulty),
        }),
      };
    case "songStarted":
      return queueChange(
        actor,
        event.params,
        (name, song) => tParts("toast.songStarted", { actor: name, song }),
        (song) => tParts("partyEvent.songStarted", { song }),
      );
    case "songPaused":
      return queueChange(
        actor,
        event.params,
        (name) => tParts("toast.paused", { actor: name }),
        (song) => tParts("partyEvent.songPaused", { song }),
      );
    case "songResumed":
      return queueChange(
        actor,
        event.params,
        (name) => tParts("toast.resumed", { actor: name }),
        (song) => tParts("partyEvent.songResumed", { song }),
      );
    case "songRestarted":
      return queueChange(
        actor,
        event.params,
        (name, song) => tParts("toast.songRestarted", { actor: name, song }),
        (song) => tParts("partyEvent.songRestarted", { song }),
      );
    case "songEnded":
      return queueChange(
        actor,
        event.params,
        (name, song) => tParts("toast.songEnded", { actor: name, song }),
        (song) => tParts("partyEvent.songEnded", { song }),
      );
    case "songSkipped":
      return queueChange(
        actor,
        event.params,
        (name, song) => tParts("toast.songSkipped", { actor: name, song }),
        (song) => tParts("partyEvent.songSkipped", { song }),
      );
    case "resultsShown":
      // Only the Stage reports results.
      return {
        actor,
        parts: tParts("partyEvent.resultsShown", { song: event.params.title }),
      };
    case "resultsClosed":
      return actor
        ? { actor, parts: tParts("toast.resultsClosed", { actor: actor.name }) }
        : { actor, parts: tParts("partyEvent.resultsClosed") };
  }
}
