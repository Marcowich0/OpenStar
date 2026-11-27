import { afterEach, describe, expect, it, vi } from "vitest";

import type { SongMedia } from "../../generated/SongMedia";
import { backgroundKind, effectsOff, prefersReducedMotion } from "./background";

const media: SongMedia = {
  audio: { url: "/api/songs/7/media/audio", native: true },
  video: {
    kind: "file",
    file: { url: "/api/songs/7/media/video", native: true },
    gapSeconds: 0,
  },
  cover: "/api/songs/7/media/cover",
  background: "/api/songs/7/media/background",
  tileColour: "grape",
};

const bare: SongMedia = { ...media, video: null, background: null };

describe("which background the sing screen shows", () => {
  it("shows the Song video when the Stage can play it and Song video is on", () => {
    expect(backgroundKind(media, true)).toBe("video");
    expect(backgroundKind({ ...media, video: { kind: "inAudio" } }, true)).toBe(
      "video",
    );
  });

  it("shows the background image without a video, or with Song video off", () => {
    expect(backgroundKind({ ...media, video: null }, true)).toBe("image");
    expect(backgroundKind(media, false)).toBe("image");
  });

  it("treats a video that still converts as no video", () => {
    const converting: SongMedia = {
      ...media,
      video: {
        kind: "file",
        file: { url: "/api/songs/7/media/video", native: false },
        gapSeconds: 0,
      },
    };
    expect(backgroundKind(converting, true)).toBe("image");
    expect(backgroundKind({ ...converting, background: null }, true)).toBe(
      "blobs",
    );
  });

  it("draws the blobs without a video and without a background image, even with a cover", () => {
    expect(backgroundKind(bare, true)).toBe("blobs");
    expect(backgroundKind({ ...bare, cover: null }, true)).toBe("blobs");
    expect(backgroundKind({ ...media, background: null }, false)).toBe("blobs");
  });
});

describe("the reduced-motion reader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the system's prefers-reduced-motion", () => {
    const query = vi.fn((q: string) => ({
      matches: q === "(prefers-reduced-motion: reduce)",
    }));
    vi.stubGlobal("matchMedia", query);
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("Effects off (the seam ticket 268 rewires)", () => {
  it("is the Stage options' effects switched off", () => {
    expect(effectsOff({ effects: false })).toBe(true);
    expect(effectsOff({ effects: true })).toBe(false);
  });
});
