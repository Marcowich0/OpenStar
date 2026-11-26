import { render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { SongClock } from "../../clock/songClock";
import { syntheticSing } from "../sing/syntheticSing";
import type { PerfTools } from "./stagePerf";
import { StagePerfProvider, useStagePerf } from "./stagePerf";

const clock = {
  songTimeAt: (moment: number) => moment / 1000,
  playingAt: () => true,
  lastSeekAt: null,
} as unknown as SongClock;

function fakeTools() {
  const synthetic = {
    state: syntheticSing("eight"),
    tick: vi.fn(),
  };
  const syntheticLanes = vi.fn(() => synthetic);
  const tools: PerfTools = {
    FrameTimeOverlay: () => <div data-perf-overlay />,
    syntheticLanes,
  };
  return { tools, synthetic, syntheticLanes };
}

function wrapper(perf: boolean, lanes: number | null) {
  return ({ children }: { children: ReactNode }) => (
    <StagePerfProvider perf={perf} lanes={lanes}>
      {children}
    </StagePerfProvider>
  );
}

const base = syntheticSing("duet");

describe("the Stage's performance check", () => {
  it("loads nothing and draws no overlay without ?perf", () => {
    const load = vi.fn(() => Promise.resolve(fakeTools().tools));
    const { result } = renderHook(
      () => useStagePerf({ state: base, clock }, load),
      { wrapper: wrapper(false, null) },
    );
    expect(load).not.toHaveBeenCalled();
    expect(result.current).toEqual({ state: null, overlay: null });
  });

  it("shows the overlay over the real lanes with ?perf", async () => {
    const { tools, syntheticLanes } = fakeTools();
    const load = vi.fn(() => Promise.resolve(tools));
    const { result } = renderHook(
      () => useStagePerf({ state: base, clock }, load),
      { wrapper: wrapper(true, null) },
    );
    await waitFor(() => {
      expect(result.current.overlay).not.toBeNull();
    });
    expect(result.current.state).toBeNull();
    expect(syntheticLanes).not.toHaveBeenCalled();
    const { container } = render(<>{result.current.overlay}</>);
    expect(container.querySelector("[data-perf-overlay]")).not.toBeNull();
  });

  it("swaps in synthetic lanes over the Song with ?perf&lanes=8, fed every frame", async () => {
    const { tools, synthetic, syntheticLanes } = fakeTools();
    const load = vi.fn(() => Promise.resolve(tools));
    let frame: FrameRequestCallback | null = null;
    const frames = {
      requestFrame: (callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      },
      cancelFrame: () => {
        frame = null;
      },
    };
    const { result, unmount } = renderHook(
      () => useStagePerf({ state: base, clock }, load, frames),
      { wrapper: wrapper(true, 8) },
    );
    await waitFor(() => {
      expect(result.current.state).not.toBeNull();
    });
    expect(syntheticLanes).toHaveBeenCalledWith(base, clock, 8);
    expect(result.current.state?.lanes).toHaveLength(8);
    (frame as FrameRequestCallback | null)?.(16);
    (frame as FrameRequestCallback | null)?.(32);
    expect(synthetic.tick).toHaveBeenCalledTimes(2);
    unmount();
    expect(frame).toBeNull();
  });
});
