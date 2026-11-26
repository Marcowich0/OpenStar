import { describe, expect, it } from "vitest";

import {
  EDITOR_VIEW,
  openView,
  scrollView,
  timeAtX,
  xAtTime,
  zoomView,
} from "./editorView";

describe("the detail view's window on Song time", () => {
  it("opens at the start of the Song at the prototype's zoom", () => {
    const view = openView();
    expect(view).toEqual({ start: 0, pixelsPerSecond: 110 });
    expect(xAtTime(view, 2)).toBe(220);
    expect(timeAtX(view, 55)).toBe(0.5);
  });

  it("scrolls in time with the wheel, by the wheel's pixels", () => {
    const view = { start: 10, pixelsPerSecond: 100 };
    expect(scrollView(view, { deltaX: 0, deltaY: 250 })).toEqual({
      start: 12.5,
      pixelsPerSecond: 100,
    });
    // A sideways wheel (trackpad) scrolls too, and wins when given.
    expect(scrollView(view, { deltaX: -100, deltaY: 30 }).start).toBe(9);
  });

  it("zooms around the pointer: the time under it stays put", () => {
    const view = { start: 10, pixelsPerSecond: 100 };
    const under = timeAtX(view, 300);
    const zoomedIn = zoomView(view, 300, -100);
    expect(zoomedIn.pixelsPerSecond).toBeGreaterThan(100);
    expect(timeAtX(zoomedIn, 300)).toBeCloseTo(under, 9);

    const zoomedOut = zoomView(view, 300, 100);
    expect(zoomedOut.pixelsPerSecond).toBeLessThan(100);
    expect(timeAtX(zoomedOut, 300)).toBeCloseTo(under, 9);
  });

  it("keeps the zoom between its limits", () => {
    const view = { start: 0, pixelsPerSecond: 100 };
    expect(zoomView(view, 0, -100_000).pixelsPerSecond).toBe(
      EDITOR_VIEW.maxPixelsPerSecond,
    );
    expect(zoomView(view, 0, 100_000).pixelsPerSecond).toBe(
      EDITOR_VIEW.minPixelsPerSecond,
    );
  });
});
