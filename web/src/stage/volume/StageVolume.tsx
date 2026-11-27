// The OpenStar volume on the Stage: `+` and `-` (also `=`, the + key without
// Shift) ask the server for one step on every scene, a Song included; the
// server stores it at the Stage output and sends the value to every browser,
// and the Stage applies it to its gain chain at once. Each step, from the
// Stage or a Remote, shows a small ink pill "Volume 80" in the top right
// for about 1.5 s. It is not a toast.

import { useEffect, useState } from "react";

import type { VolumeStep } from "../../generated/VolumeStep";
import { t } from "../../i18n/t";
import type { LiveState } from "../../live/liveState";
import { useLive } from "../../live/useLive";
import { isTextField } from "../frame/focusables";
import { ReferenceBox } from "../frame/ReferenceBox";
import { useStageFrame, useStageKeys } from "../frame/stageFrameContext";
import { stageAudio } from "../playback/stageAudio";
import { VOLUME_PILL_MS } from "./volumePill";

const selectVolume = (live: LiveState) => live.volume;
const selectSteps = (live: LiveState) => live.volumeSteps;

export function StageVolume() {
  const { store } = useStageFrame();
  const volume = useLive(selectVolume, store);
  const steps = useLive(selectSteps, store);

  const step = (direction: VolumeStep) => (event: KeyboardEvent) => {
    // Typed into a field, + and - are text.
    if (isTextField(document.activeElement)) return false;
    if (event.repeat) return true;
    store.send({ type: "stepVolume", step: direction });
    return true;
  };
  useStageKeys(
    { "+": step("up"), "=": step("up"), "-": step("down") },
    { global: true },
  );

  useEffect(() => {
    if (volume !== null) stageAudio().chain().setVolume(volume);
  }, [volume]);

  // The pill shows from each step the server tells, for 1.5 s after the last.
  const [shownFor, setShownFor] = useState(steps);
  const showing = steps !== shownFor;
  useEffect(() => {
    if (!showing) return;
    const timer = setTimeout(() => {
      setShownFor(steps);
    }, VOLUME_PILL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [showing, steps]);

  if (!showing || volume === null) return null;
  return (
    <ReferenceBox passThrough layer="toast">
      <div
        data-testid="volume-pill"
        className="absolute top-32 right-12 rounded-full bg-ink px-7 py-3 text-2xl font-semibold text-white"
      >
        {t("stage.volume", { volume })}
      </div>
    </ReferenceBox>
  );
}
