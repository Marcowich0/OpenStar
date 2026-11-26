// The words for a Calibrate mics run's rows, shared by the Stage overlay
// (#170) and the Remote's Stage tab (#174). Kept apart from the Stage's
// overlay so the Phone route loads no Stage module.

import type { CalibrationMic } from "../generated/CalibrationMic";
import type { MicKey } from "../generated/MicKey";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { Profile } from "../generated/Profile";
import { t } from "../i18n/t";
import { localMicName } from "../mics/localMics";
import { memberLook } from "../phone/memberLook";

/** A Mic's name on its row: a Phone's Party member's name. */
export function calibrationMicName(
  mic: MicKey,
  party: PartySnapshot | null,
  profiles: readonly Profile[] | undefined,
): string {
  if (mic.kind === "localMic") {
    const local = party?.localMics.find((m) => m.localMicId === mic.localMicId);
    return local ? localMicName(local.source, local.name) : mic.localMicId;
  }
  const phone = party?.phones.find((p) => p.phoneId === mic.phoneId);
  const member = party?.members.find((m) => m.memberId === phone?.memberId);
  return (
    (member && memberLook(member, profiles)?.name) || t("calibration.aPhone")
  );
}

/** A result row's text, through the catalogue. */
export function calibrationResultText(
  entry: CalibrationMic,
  name: string,
): string {
  return entry.outcome?.result === "calibrated"
    ? t("calibration.success", {
        name,
        ms: Math.round(entry.outcome.micDelayMs),
      })
    : t("calibration.failed", { name });
}
