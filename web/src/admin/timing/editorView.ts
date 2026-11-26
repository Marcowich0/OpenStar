// The detail view's window on Song time: where its left edge is and how many
// pixels a second takes. Pure; the editor keeps one in state. The constants
// are the timing-editor prototype's (variant A).

/** The window of the detail view: `start` is the Song time at its left edge. */
export interface EditorView {
  readonly start: number;
  readonly pixelsPerSecond: number;
}

export const EDITOR_VIEW = {
  pixelsPerSecond: 110,
  minPixelsPerSecond: 8,
  maxPixelsPerSecond: 800,
  /** Ctrl/Cmd+wheel: the zoom factor is `exp(−deltaY × this)`. */
  zoomPerWheelPixel: 0.002,
} as const;

export function openView(): EditorView {
  return { start: 0, pixelsPerSecond: EDITOR_VIEW.pixelsPerSecond };
}

export function xAtTime(view: EditorView, t: number): number {
  return (t - view.start) * view.pixelsPerSecond;
}

export function timeAtX(view: EditorView, x: number): number {
  return view.start + x / view.pixelsPerSecond;
}

/** The wheel scrolls in time: its sideways delta when it has one, else its vertical one. */
export function scrollView(
  view: EditorView,
  wheel: { deltaX: number; deltaY: number },
): EditorView {
  const delta = wheel.deltaX !== 0 ? wheel.deltaX : wheel.deltaY;
  return { ...view, start: view.start + delta / view.pixelsPerSecond };
}

/** Ctrl/Cmd+wheel zooms around the pointer at `x`: the time under it stays there. */
export function zoomView(
  view: EditorView,
  x: number,
  deltaY: number,
): EditorView {
  const under = timeAtX(view, x);
  const pixelsPerSecond = Math.max(
    EDITOR_VIEW.minPixelsPerSecond,
    Math.min(
      EDITOR_VIEW.maxPixelsPerSecond,
      view.pixelsPerSecond * Math.exp(-deltaY * EDITOR_VIEW.zoomPerWheelPixel),
    ),
  );
  return { start: under - x / pixelsPerSecond, pixelsPerSecond };
}

/** The view moved so Song time `t` sits at `x` (a seek from the overview strip). */
export function viewAt(view: EditorView, t: number, x: number): EditorView {
  return { ...view, start: t - x / view.pixelsPerSecond };
}
