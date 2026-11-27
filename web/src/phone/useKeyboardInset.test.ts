import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useKeyboardInset } from "./useKeyboardInset";

/** A visual viewport `height` px tall at `offsetTop`, zoomed to `scale`. */
function stubViewport(height: number, offsetTop: number, scale: number) {
  const viewport = Object.assign(new EventTarget(), {
    height,
    offsetTop,
    scale,
  });
  vi.stubGlobal("visualViewport", viewport);
  return viewport;
}

describe("useKeyboardInset", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is the height the on-screen keyboard covers", () => {
    stubViewport(window.innerHeight - 300, 0, 1);
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(300);
  });

  it("follows the keyboard as it opens", () => {
    const viewport = stubViewport(window.innerHeight, 0, 1);
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
    act(() => {
      viewport.height = window.innerHeight - 280;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(280);
  });

  it("is 0 while the page is pinch-zoomed, with no keyboard", () => {
    stubViewport(window.innerHeight / 2, 40, 2);
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
  });
});
