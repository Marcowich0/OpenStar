// What the Stage's Line-up screen shows, worked out from the Party snapshot
// (v1 spec #55, "Line-up screen"). Pure: the scene renders it. What is a
// warning and when a Line-up is valid is the server's (`LineUp.warnings`,
// `LineUp.canStart`); this only places them.

import type { Difficulty } from "../../../generated/Difficulty";
import type { LineUp } from "../../../generated/LineUp";
import type { LineUpWarning } from "../../../generated/LineUpWarning";
import type { MicKey } from "../../../generated/MicKey";
import type { PartyLocalMic } from "../../../generated/PartyLocalMic";
import type { PartyMember } from "../../../generated/PartyMember";
import type { PartyMemberId } from "../../../generated/PartyMemberId";
import type { PartySnapshot } from "../../../generated/PartySnapshot";
import type { Profile } from "../../../generated/Profile";
import type { SeatVoice } from "../../../generated/SeatVoice";
import type { SongId } from "../../../generated/SongId";
import { localMicName } from "../../../mics/localMics";

/** Enter on Voice: Voice 1 ↔ 2. */
export function nextVoice(voice: SeatVoice): SeatVoice {
  return voice === "p1" ? "p2" : "p1";
}

const DIFFICULTY_CYCLE = {
  easy: "medium",
  medium: "hard",
  hard: "easy",
} as const satisfies Record<Difficulty, Difficulty>;

/** Enter on Difficulty: Easy → Medium → Hard → Easy. */
export function nextDifficulty(difficulty: Difficulty): Difficulty {
  return DIFFICULTY_CYCLE[difficulty];
}

/** "Then <next two Songs>": the Songs of the two Requests after the head. */
export function thenSongIds(party: PartySnapshot): SongId[] {
  return party.queue.slice(1, 3).map((request) => request.songId);
}

export interface PlacedWarnings {
  /** Per seat, in seat order: the warnings that hang under its card. */
  bySeat: LineUpWarning[][];
  /** The Song's own warnings, shown above Start. */
  songWide: LineUpWarning[];
}

/** Hangs each warning under the seat it concerns, or above Start. */
export function placeWarnings(lineUp: LineUp): PlacedWarnings {
  const bySeat = lineUp.seats.map((): LineUpWarning[] => []);
  const songWide: LineUpWarning[] = [];
  for (const warning of lineUp.warnings) {
    switch (warning.code) {
      case "noMic":
      case "micBlocked": {
        const seat = lineUp.seats.findIndex(
          (s) => s.memberId === warning.params.memberId,
        );
        if (seat >= 0) bySeat[seat]?.push(warning);
        else songWide.push(warning);
        break;
      }
      case "duetNeedsVoice":
        songWide.push(warning);
        break;
    }
  }
  return { bySeat, songWide };
}

/** Whether a seat's warnings make its Mic field a bad field (warn colours). */
export function micHasProblem(warnings: readonly LineUpWarning[]): boolean {
  return warnings.some((w) => w.code === "noMic" || w.code === "micBlocked");
}

/** A switched-on Local mic the Mic list may offer. */
export interface LocalMicOption {
  localMicId: string;
  name: string;
  /** Plugged in (and, for a bridge Local mic, its bridge open). */
  present: boolean;
}

/**
 * The Local mics the Mic lists offer: the snapshot's switched-on ones, in
 * Mics-screen order, by name (or their default name).
 */
export function localMicOptions(party: PartySnapshot): LocalMicOption[] {
  return party.localMics.map((mic) => ({
    localMicId: mic.localMicId,
    name: localMicName(mic.source, mic.name),
    present: mic.present,
  }));
}

/** Where the seat meters read a Mic's latest level, in dBFS (`null`: none). */
export interface MicLevels {
  /** The Stage browser's own meter of a device's channel. */
  browser: (deviceId: string, channel: number) => number | null;
  /** A Mic bridge's 10 Hz level of one of its Local mics. */
  bridge: (localMicId: string) => number | null;
  /** The loudness of a Phone's latest Pitch reading. */
  phone: (phoneId: string) => number | null;
}

/**
 * A seat's meter level: a Stage-browser Local mic's from the Stage's own
 * meter, a bridge Local mic's from its bridge's levels, a Phone's from its
 * Pitch readings. `null` (silence) with no Mic or an unknown Local mic.
 */
export function seatLevelDbfs(
  mic: MicKey | null,
  localMics: readonly PartyLocalMic[],
  levels: MicLevels,
): number | null {
  if (mic === null) return null;
  if (mic.kind === "phone") return levels.phone(mic.phoneId);
  const local = localMics.find((l) => l.localMicId === mic.localMicId);
  if (!local) return null;
  return local.source.kind === "browser"
    ? levels.browser(local.source.deviceId, local.source.channel)
    : levels.bridge(local.localMicId);
}

/** How a Mic is named: "<member>'s Phone" or the Local mic's name. */
export type MicLabel =
  | { kind: "phone"; memberId: PartyMemberId }
  | { kind: "localMic"; name: string };

export interface MicChoice {
  mic: MicKey;
  label: MicLabel;
  /** The seat holds it now. */
  current: boolean;
  /** Another seat's member has it (dimmed, names who). */
  usedBy: PartyMemberId | null;
  /** An unplugged Local mic, or one on a closed bridge (dimmed). */
  unavailable: boolean;
}

export function sameMic(a: MicKey | null, b: MicKey | null): boolean {
  if (a === null || b === null) return false;
  if (a.kind === "phone") return b.kind === "phone" && a.phoneId === b.phoneId;
  return b.kind === "localMic" && a.localMicId === b.localMicId;
}

/** A Mic's label, or `null` for a Phone that has left the Party. */
export function micLabel(
  party: PartySnapshot,
  mic: MicKey,
  localMics: readonly LocalMicOption[],
): MicLabel | null {
  if (mic.kind === "phone") {
    const phone = party.phones.find((p) => p.phoneId === mic.phoneId);
    return phone ? { kind: "phone", memberId: phone.memberId } : null;
  }
  const local = localMics.find((l) => l.localMicId === mic.localMicId);
  return { kind: "localMic", name: local?.name ?? mic.localMicId };
}

/**
 * The Mic list of a seat: every joined Phone, then the Local mics. A Mic
 * another seat holds is dimmed with its holder's name; so is an unplugged
 * Local mic.
 */
export function micChoices(
  party: PartySnapshot,
  lineUp: LineUp,
  seat: number,
  localMics: readonly LocalMicOption[],
): MicChoice[] {
  const own = lineUp.seats[seat]?.mic ?? null;
  const holder = (mic: MicKey): PartyMemberId | null =>
    lineUp.seats.find((s, i) => i !== seat && sameMic(s.mic, mic))?.memberId ??
    null;
  const phones = party.phones.map((phone): MicChoice => {
    const mic: MicKey = { kind: "phone", phoneId: phone.phoneId };
    return {
      mic,
      label: { kind: "phone", memberId: phone.memberId },
      current: sameMic(own, mic),
      usedBy: holder(mic),
      unavailable: false,
    };
  });
  const locals = localMics.map((local): MicChoice => {
    const mic: MicKey = { kind: "localMic", localMicId: local.localMicId };
    return {
      mic,
      label: { kind: "localMic", name: local.name },
      current: sameMic(own, mic),
      usedBy: holder(mic),
      unavailable: !local.present,
    };
  });
  return [...phones, ...locals];
}

const byName = new Intl.Collator(undefined, { sensitivity: "base" });

/**
 * The Who list's Profiles that are not Party members yet: by their most
 * recent Score record, newest first; those that never sang follow, by name.
 */
export function profilesToEnter(
  members: readonly PartyMember[],
  profiles: readonly Profile[] | undefined,
): Profile[] {
  const inParty = new Set(
    members.flatMap((m) =>
      m.identity.kind === "profile" ? [m.identity.profileId] : [],
    ),
  );
  return (profiles ?? [])
    .filter((p) => !inParty.has(p.id))
    .sort((a, b) => {
      if (a.lastSungAt !== null && b.lastSungAt !== null)
        return b.lastSungAt - a.lastSungAt;
      if (a.lastSungAt !== null) return -1;
      if (b.lastSungAt !== null) return 1;
      return byName.compare(a.name, b.name);
    });
}

/** The gap between a field and its pick list, and the frame's margin. */
const PICK_LIST_GAP = 16;
const FRAME_MARGIN = 20;
const FRAME_HEIGHT = 1080;

/**
 * Where a pick list of `height` goes, as its top relative to the field's
 * top (all in reference px): under the field when it fits, else above it,
 * else as low as it fits inside the frame.
 */
export function pickListTop(
  anchor: { top: number; bottom: number },
  height: number,
): number {
  const below = anchor.bottom + PICK_LIST_GAP;
  if (below + height <= FRAME_HEIGHT - FRAME_MARGIN) return below - anchor.top;
  const above = anchor.top - PICK_LIST_GAP - height;
  if (above >= FRAME_MARGIN) return above - anchor.top;
  return (
    Math.max(FRAME_MARGIN, FRAME_HEIGHT - FRAME_MARGIN - height) - anchor.top
  );
}
