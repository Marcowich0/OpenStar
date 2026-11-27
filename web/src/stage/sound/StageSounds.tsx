// Which Stage event plays which UI sound (#261). The provider wraps the
// Stage (`StageScreen.tsx`) and hears its events in one place, so screens
// need no sound code:
//
// - `focus`: the focus ring moves from one control to another inside one
//   layer (arrows, Tab, hover, the carousel stepping). A layer opening or
//   closing and taking the focus with it is not a move.
// - `select`: a click on a button or a button-like row, which Enter makes
//   too (a native button clicks on Enter; the frame clicks a focused cover).
// - `back`: a click on a `data-stage-back` control (an overlay's close
//   button and veil), or an Esc the Stage acted on (it dismissed a layer).
// - `refuse`: a click on a greyed (`aria-disabled`) button, or the server
//   refusing one of the Stage's actions.
// - `toast`: each new toast.
// - Shared controls that sound themselves (`ui/Button`, `ui/HoldButton`,
//   marked `data-ui-cue`) ask through `UiCueContext` instead: `select`,
//   `refuse` (a greyed one shaking), `holdTick` and `holdDone`.
//
// While a Song plays every UI sound is ducked by 6 dB. The first key or
// press is the user gesture browsers want before audio may start.
// `useStageSounds()` gives screens the named sounds for their own events.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { useLive } from "../../live/useLive";
import { UiCueContext, type PlayCue, type UiCue } from "../../ui/uiCue";
import { FOCUSABLE } from "../frame/focusables";
import { pickScene } from "../frame/scenes";
import { stageAudio } from "../playback/stageAudio";
import {
  UI_SOUND_NAMES,
  createUiSounds,
  type UiSoundName,
  type UiSounds,
} from "./uiSounds";

/** What plays nothing: outside the provider (tests of single screens). */
const SILENT: UiSounds = {
  ...(Object.fromEntries(UI_SOUND_NAMES.map((name) => [name, () => {}])) as {
    [Name in UiSoundName]: () => void;
  }),
  gesture: () => {},
  setDucked: () => {},
};

const StageSoundsContext = createContext<UiSounds>(SILENT);

/** The Stage's named UI sounds, for a screen's own events. */
export function useStageSounds(): UiSounds {
  return useContext(StageSoundsContext);
}

let stage: UiSounds | null = null;

/** The Stage's UI sounds, one per page, on the Stage's own audio. */
export function stageUiSounds(): UiSounds {
  stage ??= createUiSounds({
    context: () => stageAudio().context(),
    output: () => stageAudio().chain().input,
  });
  return stage;
}

/** What a click on it sounds like, when it is a control. */
const CLICKABLE =
  'button, [role="button"], [role="option"], [role="radio"], [role="menuitem"], [data-stage-back]';

const LAYER = "[data-stage-layer]";

const selectSinging = (live: LiveState) => pickScene(live.stage) === "sing";
const selectRejection = (live: LiveState) => live.lastRejection;
const selectToasts = (live: LiveState) => live.toasts;

export interface StageSoundsProviderProps {
  store: LiveStore;
  /** Tests only: other sounds (the engine on a fake AudioContext). */
  sounds?: UiSounds;
  children: ReactNode;
}

export function StageSoundsProvider({
  store,
  sounds = stageUiSounds(),
  children,
}: StageSoundsProviderProps) {
  useGestureAndDomSounds(sounds);

  const singing = useLive(selectSinging, store);
  useEffect(() => {
    sounds.setDucked(singing);
  }, [sounds, singing]);

  // A new rejection is a new object, even with the same code.
  const rejection = useLive(selectRejection, store);
  useEffect(() => {
    if (rejection !== null) sounds.refuse();
  }, [sounds, rejection]);

  // Toast ids only grow, so a higher one is a new toast.
  const toasts = useLive(selectToasts, store);
  const newestToast = useRef(-Infinity);
  useEffect(() => {
    const newest = Math.max(...toasts.map((toast) => toast.id));
    if (newest > newestToast.current) {
      newestToast.current = newest;
      sounds.toast();
    }
  }, [sounds, toasts]);

  const cue = useMemo<PlayCue>(
    () => (name: UiCue) => {
      sounds[name satisfies UiSoundName]();
    },
    [sounds],
  );

  return (
    <StageSoundsContext value={sounds}>
      <UiCueContext value={cue}>{children}</UiCueContext>
    </StageSoundsContext>
  );
}

function useGestureAndDomSounds(sounds: UiSounds) {
  useEffect(() => {
    const onGesture = () => {
      sounds.gesture();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      sounds.gesture();
      if (event.key !== "Escape" || event.repeat) return;
      // Read once every handler had the key: the frame (or a dialog) marks
      // an Esc it acted on.
      setTimeout(() => {
        if (event.defaultPrevented) sounds.back();
      }, 0);
    };

    const onClick = (event: MouseEvent) => {
      const target =
        event.target instanceof Element
          ? event.target.closest(CLICKABLE)
          : null;
      if (target === null || target.closest("[data-ui-cue]")) return;
      if (target.closest("[data-stage-back]")) sounds.back();
      else if (target.getAttribute("aria-disabled") === "true") sounds.refuse();
      else sounds.select();
    };

    // The last element focused: when the focus leaves a removed element,
    // the browser gives no `relatedTarget`.
    let last: Element | null = null;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target === null) return;
      const before =
        event.relatedTarget instanceof Element ? event.relatedTarget : last;
      last = target;
      if (before === null || before === target || !before.isConnected) return;
      if (!target.matches(FOCUSABLE)) return;
      const layer = target.closest(LAYER);
      if (layer !== null && layer === before.closest(LAYER)) sounds.focus();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onGesture, true);
    document.addEventListener("click", onClick);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onGesture, true);
      document.removeEventListener("click", onClick);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [sounds]);
}
