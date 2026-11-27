// The motion mode (#260): springs by default, 120 ms fades when the browser
// asks for reduced motion or the Stage's Effects are off.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { STAGE_OPTIONS } from "../stageOptions/stageOptions";
import {
  effectsOff,
  MotionMode,
  prefersReducedMotion,
  REDUCED_MOTION_QUERY,
} from "./motion";

/** A browser whose reduced-motion query answers `reduced`, and can change. */
function stubReducedMotion(reduced: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    matches: reduced,
    media: REDUCED_MOTION_QUERY,
    addEventListener: (_: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: () => void) => {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal("matchMedia", (query: string) => {
    expect(query).toBe(REDUCED_MOTION_QUERY);
    return list;
  });
  return {
    change(next: boolean) {
      list.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

const mode = () => document.documentElement.dataset.motion;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MotionMode", () => {
  it("leaves the springs on by default", () => {
    stubReducedMotion(false);
    render(<MotionMode effectsOff={false} />);
    expect(mode()).toBe("spring");
  });

  it("falls back to fades when the browser asks for reduced motion", () => {
    stubReducedMotion(true);
    render(<MotionMode effectsOff={false} />);
    expect(mode()).toBe("fade");
  });

  it("falls back to fades when Effects are off", () => {
    stubReducedMotion(false);
    render(<MotionMode effectsOff />);
    expect(mode()).toBe("fade");
  });

  it("follows a change of the system setting", () => {
    const media = stubReducedMotion(false);
    render(<MotionMode effectsOff={false} />);
    act(() => {
      media.change(true);
    });
    expect(mode()).toBe("fade");
    act(() => {
      media.change(false);
    });
    expect(mode()).toBe("spring");
  });

  it("works in a browser without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<MotionMode effectsOff={false} />);
    expect(mode()).toBe("spring");
  });

  it("takes its mark off the page when it unmounts", () => {
    stubReducedMotion(true);
    const { unmount } = render(<MotionMode effectsOff={false} />);
    unmount();
    expect(mode()).toBeUndefined();
  });
});

describe("prefersReducedMotion, the one reduced-motion reader", () => {
  it("reads the system's prefers-reduced-motion now", () => {
    const media = stubReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    media.change(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("is false in a browser without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("effectsOff", () => {
  it("is off only when the Stage options turn Effects off", () => {
    expect(effectsOff(STAGE_OPTIONS.defaults)).toBe(false);
    expect(effectsOff({ ...STAGE_OPTIONS.defaults, effects: false })).toBe(
      true,
    );
  });
});
