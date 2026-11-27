// The `/stage` shell ("Big moments", v1 spec #55): no navigation chrome, one
// full-screen scene for the current Stage state, the pill row, the overlays,
// and the keyboard and mouse driving one focus ring.
//
// Keys, in order: the top layer's (and global) `useStageKeys` bindings, then
// the frame's own: Esc dismisses the top layer (a pick list before an
// overlay), the arrows move the focus (`focusMove.ts`), Enter picks the
// focused element, `S`/`Q`/`P` toggle the Songs, Queue and People overlays.
// Buttons pick themselves on Enter; hold buttons (`ui/HoldButton`) take Enter
// key down and up for the hold. While the focus is in a dialog outside the
// frame (react-aria's modals), the frame leaves every key to it. Toasts (`../toasts/StageToasts.tsx`) lie
// above every scene and overlay and take no focus.

import "./stageFrame.css";

import { useEffect, useMemo, useRef, useState } from "react";

import type { SongSummary } from "../../generated/SongSummary";
import type { LiveState } from "../../live/liveState";
import type { LiveStore } from "../../live/liveStore";
import { liveStore, useLive } from "../../live/useLive";
import {
  FOCUSABLE,
  focusDefault,
  focusablesIn,
  isTextField,
} from "./focusables";
import { nextFocus, type FocusDirection } from "./focusMove";
import { OVERLAY_KEYS, type OverlayId } from "./overlayIds";
import { StageOverlay } from "./overlays";
import { PillRow } from "./PillRow";
import { StageToasts } from "../toasts/StageToasts";
import { SongSearchProvider } from "../search/songSearch";
import { StageVolume } from "../volume/StageVolume";
import { ReferenceBox } from "./ReferenceBox";
import { SCENES, type SceneDefinition } from "./sceneComponents";
import { SCENE_RULES, pickScene, type SceneId } from "./scenes";
import {
  FrameContext,
  LayerContext,
  SCENE_LAYER,
  type FrameInternals,
  type StageFrameApi,
} from "./stageFrameContext";

const ARROWS: Readonly<Record<string, FocusDirection>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

const selectStage = (live: LiveState) => live.stage;
const selectAvSync = (live: LiveState) => live.avSync;
const selectCalibrating = (live: LiveState) => live.calibration !== null;

function reloadAsStage() {
  window.location.reload();
}

export interface StageFrameProps {
  store?: LiveStore;
  /** Makes this browser the Stage again; reloading opens `/ws/stage` anew. */
  takeStageBack?: () => void;
  /** Tests only: other scene components, and another scene choice. */
  scenes?: Record<SceneId, SceneDefinition>;
  chooseScene?: typeof pickScene;
}

export function StageFrame({
  store = liveStore(),
  takeStageBack = reloadAsStage,
  scenes = SCENES,
  chooseScene = pickScene,
}: StageFrameProps) {
  const stage = useLive(selectStage, store);
  const scene = chooseScene(stage);
  const rules = SCENE_RULES[scene];
  const [overlay, setOverlay] = useState<OverlayId | null>(null);
  const [songDetail, setSongDetail] = useState<SongSummary | null>(null);
  // A scene that refuses overlays (a Song plays) closes the open one.
  if (!rules.overlays && overlay !== null) setOverlay(null);
  // Check A/V sync (#163) shows while the server says it runs, whoever
  // started it; the Setup menu only asks the server to start it.
  const avSync = useLive(selectAvSync, store);
  const [shownAvSync, setShownAvSync] = useState(false);
  if (avSync !== shownAvSync) {
    setShownAvSync(avSync);
    if (avSync && rules.overlays) setOverlay("avSync");
    else if (!avSync && overlay === "avSync") setOverlay(null);
  }
  // Calibrate mics (#170) likewise shows while the server holds its run.
  const calibrating = useLive(selectCalibrating, store);
  const [shownCalibrating, setShownCalibrating] = useState(false);
  if (calibrating !== shownCalibrating) {
    setShownCalibrating(calibrating);
    if (calibrating && rules.overlays) setOverlay("calibrateMics");
    else if (!calibrating && overlay === "calibrateMics") setOverlay(null);
  }

  const frameRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<FrameInternals["layersRef"]["current"]>([]);
  const keysRef = useRef<FrameInternals["keysRef"]["current"]>([]);

  const allowOverlays = rules.overlays;
  const api = useMemo<StageFrameApi>(() => {
    // Leaving an overlay the server holds ends it for every browser.
    const endShared = (open: OverlayId | null) => {
      if (open === "avSync") store.send({ type: "endAvSync" });
      if (open === "calibrateMics") store.send({ type: "endCalibration" });
    };
    return {
      scene,
      overlay,
      openOverlay: (id) => {
        if (!allowOverlays) return;
        if (id === "avSync") {
          store.send({ type: "startAvSync" });
          return;
        }
        if (id === "calibrateMics") {
          store.send({ type: "openCalibration" });
          return;
        }
        endShared(overlay);
        setOverlay(id);
      },
      songDetail: overlay === "songDetail" ? songDetail : null,
      openSongDetail: (song) => {
        if (!allowOverlays) return;
        endShared(overlay);
        setSongDetail(song);
        setOverlay("songDetail");
      },
      closeOverlay: () => {
        // Done, Cancel, Esc or the close button ends the check or the run
        // for every browser.
        endShared(overlay);
        setOverlay(null);
      },
      store,
      takeStageBack,
    };
  }, [scene, overlay, songDetail, allowOverlays, store, takeStageBack]);
  const internals = useMemo<FrameInternals>(
    () => ({ api, layersRef, keysRef }),
    [api],
  );

  // The top layer's element: the last opened pick list or overlay, or the scene.
  const topRoot = (): Element | null => {
    const top = layersRef.current.at(-1)?.id ?? SCENE_LAYER;
    const roots = frameRef.current?.querySelectorAll("[data-stage-layer]");
    return (
      [...(roots ?? [])].find(
        (root) => root.getAttribute("data-stage-layer") === top,
      ) ?? null
    );
  };

  // A new scene starts with its default focus.
  useEffect(() => {
    const root = frameRef.current?.querySelector(
      `[data-stage-layer="${SCENE_LAYER}"]`,
    );
    if (root && layersRef.current.length === 0) focusDefault(root);
  }, [scene]);

  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  });

  useEffect(() => {
    function moveFocus(direction: FocusDirection) {
      const root = topRoot();
      if (!root) return;
      const current = document.activeElement;
      if (!(current instanceof HTMLElement) || !root.contains(current)) {
        focusDefault(root);
        return;
      }
      const candidates = focusablesIn(root)
        .filter((element) => element !== current)
        .map((element) => ({
          id: element,
          rect: element.getBoundingClientRect(),
        }));
      const next = nextFocus(
        current.getBoundingClientRect(),
        candidates,
        direction,
      );
      next?.focus({ preventScroll: true });
    }

    function runBindings(event: KeyboardEvent): boolean {
      const top = layersRef.current.at(-1)?.id ?? SCENE_LAYER;
      const names =
        event.key.length === 1
          ? [event.key, event.key.toLowerCase(), event.key.toUpperCase()]
          : [event.key];
      for (const registration of [...keysRef.current].reverse()) {
        if (!registration.global && registration.layer !== top) continue;
        const bindings = registration.bindings.current;
        const name = names.find((n) => n in bindings);
        const handler = name === undefined ? undefined : bindings[name];
        if (handler && handler(event) !== false) return true;
      }
      return false;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      // A dialog above the frame, portalled outside it (the Downloads
      // overlay's video picker, the Admin PIN pad), takes its own keys.
      const focused = document.activeElement;
      if (
        focused instanceof HTMLElement &&
        focused !== document.body &&
        !frameRef.current?.contains(focused)
      ) {
        return;
      }
      if (runBindings(event)) {
        event.preventDefault();
        return;
      }
      const frame = apiRef.current;
      if (event.key === "Escape") {
        const top = layersRef.current.at(-1);
        if (top) {
          event.preventDefault();
          top.dismiss();
        }
        return;
      }
      const active = document.activeElement;
      if (isTextField(active)) return;
      if (event.key === "Tab") {
        // Tab stays inside the top layer, in document order.
        const root = topRoot();
        if (!root) return;
        event.preventDefault();
        const all = focusablesIn(root);
        if (all.length === 0) return;
        const at = active instanceof HTMLElement ? all.indexOf(active) : -1;
        const step = event.shiftKey ? -1 : 1;
        const next = all[(at + step + all.length) % all.length] ?? all[0];
        next?.focus({ preventScroll: true });
        return;
      }
      const direction = ARROWS[event.key];
      if (direction) {
        event.preventDefault();
        moveFocus(direction);
        return;
      }
      if (event.key === "Enter") {
        // Buttons pick (or hold) themselves; other focusables are clicked.
        if (event.defaultPrevented || event.repeat) return;
        if (
          active instanceof HTMLElement &&
          frameRef.current?.contains(active) &&
          active.matches("[data-stage-focus]") &&
          !active.matches("button, a, input")
        ) {
          event.preventDefault();
          active.click();
        }
        return;
      }
      const overlayId = OVERLAY_KEYS[event.key.toLowerCase()];
      if (overlayId) {
        // Not while a pick list is open: only the overlay's own layer may be up.
        const pickListOpen =
          layersRef.current.length > (frame.overlay === null ? 0 : 1);
        if (pickListOpen) return;
        event.preventDefault();
        if (frame.overlay === overlayId) frame.closeOverlay();
        else frame.openOverlay(overlayId);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
    // topRoot reads refs only.
  }, []);

  const { component: Scene, fullScreen = false } = scenes[scene];
  const shownOverlay = rules.overlays ? overlay : null;

  return (
    <FrameContext value={internals}>
      <SongSearchProvider>
        <div
          ref={frameRef}
          data-stage-frame
          data-scene={scene}
          className="fixed inset-0 overflow-hidden select-none"
          onPointerOver={(event) => {
            // Hover never takes the focus out of a text field (the song
            // browser's search box): typing would land elsewhere.
            if (isTextField(document.activeElement)) return;
            const root = topRoot();
            const target =
              event.target instanceof Element
                ? event.target.closest(FOCUSABLE)
                : null;
            if (
              target instanceof HTMLElement &&
              root?.contains(target) &&
              target !== document.activeElement
            ) {
              target.focus({ preventScroll: true });
            }
          }}
        >
          <LayerContext value={SCENE_LAYER}>
            <div data-stage-layer={SCENE_LAYER} className="absolute inset-0">
              {fullScreen ? (
                <Scene />
              ) : (
                <ReferenceBox>
                  <Scene />
                </ReferenceBox>
              )}
              {rules.pillRow && (
                <ReferenceBox passThrough>
                  <PillRow setup={rules.setup} />
                </ReferenceBox>
              )}
            </div>
          </LayerContext>
          {shownOverlay && <StageOverlay id={shownOverlay} />}
          <StageToasts store={store} duringSong={scene === "sing"} />
          <StageVolume />
        </div>
      </SongSearchProvider>
    </FrameContext>
  );
}
