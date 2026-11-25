// The seams the Stage's screens use inside the frame (`StageFrame.tsx`):
//
// - `useStageFrame()`: the current scene and overlay, `openOverlay(id)`,
//   `closeOverlay()`, the live store and `takeStageBack()`.
// - `useStageKeys(bindings, { global })`: key bindings. They fire only while
//   the layer they were bound in is the top one (the scene, an overlay or a
//   pick list), before the frame's own keys; `global` bindings fire on every
//   layer and scene (the volume keys). A handler that returns `false` lets the
//   key go on to the next binding and the frame.
// - `<StageLayer onDismiss>`: a layer above the scene. Esc dismisses the top
//   layer; arrows and the mouse move the focus only inside it. Overlays and
//   `StagePickList` are layers.

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

import type { LiveStore } from "../../live/liveStore";
import { focusDefault } from "./focusables";
import type { OverlayId } from "./overlayIds";
import type { SceneId } from "./scenes";

export interface StageFrameApi {
  scene: SceneId;
  /** The open overlay, or `null`. */
  overlay: OverlayId | null;
  /** Opens an overlay, unless the scene refuses overlays (a Song plays). */
  openOverlay: (id: OverlayId) => void;
  closeOverlay: () => void;
  store: LiveStore;
  /** Makes this browser the Stage again (Stage moved here). */
  takeStageBack: () => void;
}

/** A key handler; returning `false` passes the key on. */
export type StageKeyHandler = (event: KeyboardEvent) => boolean | undefined;

/**
 * Handlers by `KeyboardEvent.key` ("ArrowLeft", "Enter", " ", "+"). Single
 * letters match either case.
 */
export type StageKeyBindings = Readonly<Record<string, StageKeyHandler>>;

interface KeyRegistration {
  layer: string;
  global: boolean;
  bindings: { current: StageKeyBindings };
}

interface Layer {
  id: string;
  dismiss: () => void;
}

/** What the frame shares with its layers; not for screens. */
export interface FrameInternals {
  api: StageFrameApi;
  layersRef: { current: Layer[] };
  keysRef: { current: KeyRegistration[] };
}

export const FrameContext = createContext<FrameInternals | null>(null);

/** The id of the layer a component sits in; the scene's is `SCENE_LAYER`. */
export const SCENE_LAYER = "scene";
export const LayerContext = createContext<string>(SCENE_LAYER);

function useFrameInternals(): FrameInternals {
  const frame = useContext(FrameContext);
  if (!frame) throw new Error("used outside the StageFrame");
  return frame;
}

export function useStageFrame(): StageFrameApi {
  return useFrameInternals().api;
}

export function useStageKeys(
  bindings: StageKeyBindings,
  { global = false }: { global?: boolean } = {},
): void {
  const { keysRef } = useFrameInternals();
  const layer = useContext(LayerContext);
  const latest = useRef(bindings);
  useEffect(() => {
    latest.current = bindings;
  });
  useEffect(() => {
    const registration = { layer, global, bindings: latest };
    keysRef.current = [...keysRef.current, registration];
    return () => {
      keysRef.current = keysRef.current.filter((r) => r !== registration);
    };
  }, [keysRef, layer, global]);
}

export interface StageLayerProps {
  /** Esc (and the veil, for overlays) calls it. */
  onDismiss: () => void;
  children: ReactNode;
  className?: string;
  /** For a dialog: `role`, `aria-modal`, `aria-labelledby` and the like. */
  role?: string;
  "aria-modal"?: boolean;
  "aria-labelledby"?: string;
  "aria-label"?: string;
}

/**
 * A layer above the scene: it takes the focus, gives it back when it closes,
 * and is the only place arrows, Tab, hover and its own key bindings act while
 * it is on top.
 */
export function StageLayer({
  onDismiss,
  children,
  className,
  ...aria
}: StageLayerProps) {
  const { layersRef } = useFrameInternals();
  const id = useId();
  const element = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });
  useLayoutEffect(() => {
    const layer = {
      id,
      dismiss: () => {
        dismiss.current();
      },
    };
    layersRef.current = [...layersRef.current, layer];
    // The layer takes the focus and gives it back when it closes.
    const opener = document.activeElement;
    if (element.current) focusDefault(element.current);
    return () => {
      layersRef.current = layersRef.current.filter((l) => l !== layer);
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [id, layersRef]);
  return (
    <LayerContext value={id}>
      <div ref={element} data-stage-layer={id} className={className} {...aria}>
        {children}
      </div>
    </LayerContext>
  );
}
