// A Line-up seat's Mic, as the Phone's Stage tab shows it (v1 spec #49,
// "Stage tab"): the Mic list in the seat sheet and the Mic's name on the seat
// row. Pure functions of the Party snapshot, this Phone's id and the kept
// Local mics.

import type { LineUp } from "../../generated/LineUp";
import type { LocalMic } from "../../generated/LocalMic";
import type { MicKey } from "../../generated/MicKey";
import type { PartyMemberId } from "../../generated/PartyMemberId";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { PhoneId } from "../../generated/PhoneId";
import { t } from "../../i18n/t";
import { localMicName } from "../../mics/localMics";

/** What naming a Mic needs. */
export interface MicNaming {
  party: Pick<PartySnapshot, "phones">;
  /** This Phone's own id: its Mic is "This phone". */
  myPhoneId: PhoneId;
  /** Every kept Local mic (`GET /api/local-mics`); empty until it loads. */
  localMics: readonly LocalMic[];
  nameOf: (memberId: PartyMemberId) => string;
}

/** One Mic the seat sheet offers. */
export interface MicOption {
  mic: MicKey;
  name: string;
  /** Another seat has it: disabled and tagged "in use". */
  inUse: boolean;
  /** This seat's own Mic. */
  current: boolean;
}

function sameMic(a: MicKey | null, b: MicKey): boolean {
  if (a === null || a.kind !== b.kind) return false;
  return a.kind === "phone"
    ? b.kind === "phone" && a.phoneId === b.phoneId
    : b.kind === "localMic" && a.localMicId === b.localMicId;
}

function localName(mic: LocalMic): string {
  return localMicName(mic.source, mic.name);
}

/**
 * A Mic's name: "This phone", "<name>'s phone", or a Local mic's name. A
 * Phone that left the Party, or a Local mic not loaded yet, has no name to
 * show, so it reads as an empty string.
 */
export function micName(mic: MicKey, naming: MicNaming): string {
  if (mic.kind === "phone") {
    if (mic.phoneId === naming.myPhoneId) return t("stageTab.thisPhone");
    const phone = naming.party.phones.find((p) => p.phoneId === mic.phoneId);
    return phone
      ? t("stageTab.phoneOf", { name: naming.nameOf(phone.memberId) })
      : "";
  }
  const local = naming.localMics.find((m) => m.localMicId === mic.localMicId);
  return local ? localName(local) : "";
}

/**
 * The Mics the seat sheet offers for `seat`: every joined Phone in the order
 * they joined, then every switched-on Local mic in the kept order. A Mic in
 * another seat is in use. Whether a Local mic is present right now is the
 * server's to say (`micNotAvailable`).
 */
export function seatMicOptions(
  input: MicNaming & { lineUp: LineUp; seat: number },
): MicOption[] {
  const { lineUp, seat } = input;
  const own = lineUp.seats[seat]?.mic ?? null;
  const others = lineUp.seats.filter((_, i) => i !== seat).map((s) => s.mic);
  const mics: MicKey[] = [
    ...input.party.phones.map((p): MicKey => ({
      kind: "phone",
      phoneId: p.phoneId,
    })),
    ...input.localMics
      .filter((m) => m.switchedOn)
      .map((m): MicKey => ({ kind: "localMic", localMicId: m.localMicId })),
  ];
  return mics.map((mic) => ({
    mic,
    name: micName(mic, input),
    inUse: others.some((other) => sameMic(other, mic)),
    current: sameMic(own, mic),
  }));
}
