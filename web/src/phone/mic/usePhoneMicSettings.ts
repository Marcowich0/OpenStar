// This Phone's own Mic settings at the Stage's current output: the Mic delay
// and effective Mic threshold the Stage would score it with now (the same
// `resolveMicSettings` the Stage uses), and setting the threshold by hand
// from the Phone's own meter. The Stage output and the OpenStar volume come
// with the server's `volume`; the stored values from `GET /api/mic-settings`,
// refetched after every `micSettings` change notice.

import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import type { PhoneId } from "../../generated/PhoneId";
import type { StageOutputMicSettings } from "../../generated/StageOutputMicSettings";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import {
  resolveMicSettings,
  type MicSettings,
  type StoredMicSettings,
} from "../../mics/micSettings";
import {
  handReferenceDbfs,
  stageOutputMicSettingsQuery,
} from "../../mics/micSettingsQuery";
import { OPENSTAR_VOLUME } from "../../playback/gain";

/** How long the slider rests before a hand setting is sent. */
export const HAND_SETTING_SEND_AFTER_MS = 300;

export interface PhoneMicSettings extends MicSettings {
  /**
   * Whether the Stage's output and this Phone's stored values are known, so
   * a hand setting has an output to be kept for.
   */
  ready: boolean;
  /**
   * Sets this Phone's Mic threshold by hand to `effectiveDbfs` at the
   * current volume: shown at once, sent once the slider rests.
   */
  setByHand: (effectiveDbfs: number) => void;
}

const selectOutput = (state: LiveState) => state.stageOutput;
const selectVolume = (state: LiveState) => state.volume;

/** `values` with this Phone's threshold set by hand to `referenceDbfs`. */
export function withHandThreshold(
  values: StageOutputMicSettings,
  phoneId: PhoneId,
  referenceDbfs: number,
): StageOutputMicSettings {
  const mine = (entry: StageOutputMicSettings["mics"][number]) =>
    entry.mic.kind === "phone" && entry.mic.phoneId === phoneId;
  const settings: StoredMicSettings = {
    ...values.mics.find(mine)?.settings,
    micThreshold: { referenceDbfs, setBy: "hand" },
  };
  return {
    ...values,
    mics: [
      ...values.mics.filter((entry) => !mine(entry)),
      { mic: { kind: "phone", phoneId }, settings },
    ],
  };
}

export function usePhoneMicSettings(
  store: LiveStore,
  phoneId: PhoneId,
): PhoneMicSettings {
  const queryClient = useQueryClient();
  const stageOutput = useLive(selectOutput, store);
  const volume = useLive(selectVolume, store) ?? OPENSTAR_VOLUME.default;
  const query = stageOutputMicSettingsQuery(stageOutput ?? "");
  const { data } = useQuery({ ...query, enabled: stageOutput !== null });
  const values =
    stageOutput !== null && data?.stageOutput === stageOutput ? data : null;
  const stored = values?.mics.find(
    (entry) => entry.mic.kind === "phone" && entry.mic.phoneId === phoneId,
  )?.settings;
  const resolved = resolveMicSettings({ kind: "phone", stored, volume });

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return {
    ...resolved,
    ready: values !== null,
    setByHand(effectiveDbfs) {
      if (values === null || stageOutput === null) return;
      const referenceDbfs = handReferenceDbfs(effectiveDbfs, volume);
      queryClient.setQueryData(query.queryKey, (old) =>
        old ? withHandThreshold(old, phoneId, referenceDbfs) : old,
      );
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        store.send({
          type: "setPhoneMicThreshold",
          stageOutput,
          phoneId,
          referenceDbfs,
        });
      }, HAND_SETTING_SEND_AFTER_MS);
    },
  };
}
