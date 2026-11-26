import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../api/queryClient";
import type { Job } from "../../generated/Job";
import type { JobState } from "../../generated/JobState";
import type { SongDetail } from "../../generated/SongDetail";
import { song as testSong } from "../../timing/testSong";
import { TimingEditor } from "./TimingEditor";

// A Song with GAP 0 and one Beat 0.1 s: one Line of two Notes of pitch C,
// 0–1 s and 1–2 s.
function detail(): SongDetail {
  const base = testSong(1, { gapSeconds: 0, beatsPerMinute: 600 });
  const note = (start: number, line: number) => ({
    kind: "normal" as const,
    start,
    length: 10,
    pitch: 0,
    text: "la",
    line,
  });
  return {
    id: 7,
    path: "Nobody - Placeholder/song.txt",
    song: {
      ...base,
      voices: [{ lines: [{ notes: [note(0, 5), note(10, 6)], end: null }] }],
    },
    noteFingerprint: "f",
    identity: {
      kind: "artistTitle",
      artist: "Nobody",
      title: "Placeholder",
      duet: false,
    },
    lengthSeconds: 30,
    preparing: false,
    media: {
      audio: { url: "/api/songs/7/media/audio", native: true },
      video: null,
      cover: null,
      background: null,
      tileColour: "teal",
    },
    loudnessLufs: null,
    warnings: [],
  };
}

/** 3 s of track: the first Note sung on its pitch, the second not at all. */
function trackBytes(): ArrayBuffer {
  const frames = 300;
  const view = new DataView(new ArrayBuffer(frames * 12));
  for (let i = 0; i < 100; i++)
    view.setFloat32(i * 12, 440 * 2 ** (-9 / 12), true);
  for (let i = 0; i < frames; i++) view.setFloat32(i * 12 + 8, 0.2, true);
  return view.buffer;
}

interface Server {
  calls: string[];
}

function fakeServer(start: unknown): Server {
  const server: Server = { calls: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      server.calls.push(`${method} ${input}`);
      const json = (body: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      if (input === "/api/songs/7") return json(detail());
      if (method === "POST" && input === "/api/songs/7/pitch-track")
        return json(start);
      if (input === "/api/songs/7/pitch-track")
        return Promise.resolve(new Response(trackBytes(), { status: 200 }));
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
  return server;
}

function jobFeed() {
  const listeners = new Set<(job: Job) => void>();
  return {
    onJobChanged(listener: (job: Job) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async send(state: JobState) {
      act(() => {
        for (const l of [...listeners]) l({ id: 3, kind: "pitchTrack", state });
      });
      await settle();
    },
  };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function open(start: unknown = { state: "ready" }) {
  const server = fakeServer(start);
  const feed = jobFeed();
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <TimingEditor song={7} store={feed} />,
    }),
    history: createMemoryHistory(),
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await settle();
  return { server, feed };
}

const detailCanvas = () => screen.getByRole("img", { name: /detail/i });
const overviewCanvas = () => screen.getByRole("img", { name: /overview/i });
const share = () => screen.getByRole("meter", { name: "Notes on the singing" });

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  // jsdom has no pointer capture.
  Element.prototype.setPointerCapture = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("opening a Song's Timing editor", () => {
  it("names the Song and asks for its Pitch track", async () => {
    const { server } = await open();
    expect(
      screen.getByRole("heading", { name: /Placeholder/ }),
    ).toBeInTheDocument();
    expect(server.calls).toContain("POST /api/songs/7/pitch-track");
  });

  it("shows the share of a cached track at once", async () => {
    await open({ state: "ready" });
    // 100 of the 200 covered frames match.
    expect(share()).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("50 %")).toBeInTheDocument();
    expect(detailCanvas()).toHaveAttribute("data-pitch-track", "ready");
  });

  it("shows progress while the job listens, then the share once it is done", async () => {
    const { feed } = await open({ state: "computing", job: 3 });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Listening to the song…",
    );
    expect(detailCanvas()).toHaveAttribute("data-pitch-track", "pending");
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText("Waiting for the singing")).toBeInTheDocument();

    await feed.send({ type: "running", percent: 40 });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Listening to the song… 40 %",
    );

    await feed.send({ type: "done" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(share()).toHaveAttribute("aria-valuenow", "50");
    expect(detailCanvas()).toHaveAttribute("data-pitch-track", "ready");
  });

  it("says it couldn't listen when the job fails, and stays usable", async () => {
    const { feed } = await open({ state: "computing", job: 3 });
    await feed.send({ type: "failed", reason: { code: "pitchTrackFailed" } });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't listen to this Song",
    );
    expect(detailCanvas()).toHaveAttribute("data-pitch-track", "failed");
    // The view still scrolls.
    fireEvent.wheel(detailCanvas(), { deltaY: 110 });
    expect(detailCanvas()).toHaveAttribute("data-view-start", "1");
  });

  it("never changes the Song: nothing but the Song and its Pitch track is asked for", async () => {
    const { server } = await open();
    expect(server.calls.sort()).toEqual([
      "GET /api/songs/7",
      "GET /api/songs/7/pitch-track",
      "POST /api/songs/7/pitch-track",
    ]);
  });
});

describe("moving around the Timing editor", () => {
  it("scrolls in time with the wheel", async () => {
    await open();
    fireEvent.wheel(detailCanvas(), { deltaY: 220 });
    expect(detailCanvas()).toHaveAttribute("data-view-start", "2");
    expect(detailCanvas()).toHaveAttribute("data-pixels-per-second", "110");
  });

  it("zooms around the pointer with Ctrl or Cmd and the wheel", async () => {
    await open();
    fireEvent.wheel(detailCanvas(), {
      deltaY: -100,
      ctrlKey: true,
      clientX: 0,
    });
    const zoomed = Number(
      detailCanvas().getAttribute("data-pixels-per-second"),
    );
    expect(zoomed).toBeGreaterThan(110);
    // The time under the pointer (x = 0, Song time 0) stays put.
    expect(detailCanvas()).toHaveAttribute("data-view-start", "0");

    fireEvent.wheel(detailCanvas(), { deltaY: 100, metaKey: true, clientX: 0 });
    expect(
      Number(detailCanvas().getAttribute("data-pixels-per-second")),
    ).toBeLessThan(zoomed);
  });

  it("seeks by dragging on the ruler, and only there", async () => {
    await open();
    const canvas = detailCanvas();
    fireEvent.pointerDown(canvas, { clientX: 220, clientY: 10, pointerId: 1 });
    expect(canvas).toHaveAttribute("data-playhead", "2");
    fireEvent.pointerMove(canvas, { clientX: 330, clientY: 200, pointerId: 1 });
    expect(canvas).toHaveAttribute("data-playhead", "3");
    fireEvent.pointerUp(canvas, { clientX: 330, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 440, clientY: 10, pointerId: 1 });
    expect(canvas).toHaveAttribute("data-playhead", "3");

    // Below the ruler, a press does not seek.
    fireEvent.pointerDown(canvas, { clientX: 55, clientY: 200, pointerId: 1 });
    expect(canvas).toHaveAttribute("data-playhead", "3");
  });

  it("seeks where the overview strip is clicked", async () => {
    await open();
    const strip = overviewCanvas();
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 64 }),
    );
    // The strip shows the Song's 30 s over 300 px.
    fireEvent.pointerDown(strip, { clientX: 120, clientY: 30, pointerId: 1 });
    expect(detailCanvas()).toHaveAttribute("data-playhead", "12");
    expect(Number(detailCanvas().getAttribute("data-view-start"))).toBeLessThan(
      12,
    );
  });
});
