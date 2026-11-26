import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FrameTimeOverlay } from "./FrameTimeOverlay";

function fakeFrames() {
  let next: FrameRequestCallback | null = null;
  return {
    requestFrame: (callback: FrameRequestCallback) => {
      next = callback;
      return 1;
    },
    cancelFrame: () => {
      next = null;
    },
    /** Runs animation frames at `hz` for `count` frames from `from` ms. */
    run(hz: number, count: number, from = 0) {
      act(() => {
        for (let i = 0; i < count; i++) next?.(from + (i * 1000) / hz);
      });
    },
    running: () => next !== null,
  };
}

describe("the frame-time overlay", () => {
  it("shows the current, mean and worst frame time and the frame budget", () => {
    const frames = fakeFrames();
    render(
      <FrameTimeOverlay
        requestFrame={frames.requestFrame}
        cancelFrame={frames.cancelFrame}
      />,
    );
    expect(screen.getByText("Measuring frame times")).toBeTruthy();
    frames.run(144, 300);
    const overlay = document.querySelector("[data-perf-overlay]");
    expect(overlay?.textContent).toContain("Frame 6.9 ms");
    expect(overlay?.textContent).toContain("Mean 6.9 ms");
    expect(overlay?.textContent).toContain("Worst 6.9 ms");
    expect(overlay?.textContent).toContain("Budget 6.9 ms (144 Hz)");
    expect(overlay?.getAttribute("data-over-budget")).toBe("false");
  });

  it("marks a second whose worst frame missed the budget", () => {
    const frames = fakeFrames();
    render(
      <FrameTimeOverlay
        requestFrame={frames.requestFrame}
        cancelFrame={frames.cancelFrame}
      />,
    );
    frames.run(144, 200);
    // Then a stretch at half the rate: every frame takes two refreshes.
    frames.run(72, 100, 200 * (1000 / 144));
    const overlay = document.querySelector("[data-perf-overlay]");
    expect(overlay?.textContent).toContain("Worst 13.9 ms");
    expect(overlay?.getAttribute("data-over-budget")).toBe("true");
  });

  it("stops its frame loop when it goes", () => {
    const frames = fakeFrames();
    const { unmount } = render(
      <FrameTimeOverlay
        requestFrame={frames.requestFrame}
        cancelFrame={frames.cancelFrame}
      />,
    );
    expect(frames.running()).toBe(true);
    unmount();
    expect(frames.running()).toBe(false);
  });
});
