import { afterEach, describe, expect, it, vi } from "vitest";

import type { Job } from "../generated/Job";
import type { JobState } from "../generated/JobState";
import { loadPitchTrack, type PitchTrackLoad } from "./loadPitchTrack";

/** Two frames: 440 Hz voiced, then unvoiced. */
function trackBytes(): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(24));
  [440, 0.9, 0.5, 0, 0, 0.01].forEach((v, i) => {
    view.setFloat32(i * 4, v, true);
  });
  return view.buffer;
}

interface Server {
  calls: string[];
}

/** Stubs `fetch`: the POST answers `start`, the GET the frames (or 404). */
function fakeServer(start: unknown, frames = true): Server {
  const server: Server = { calls: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      server.calls.push(`${method} ${input}`);
      if (method === "POST")
        return Promise.resolve(
          new Response(JSON.stringify(start), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      return Promise.resolve(
        frames
          ? new Response(trackBytes(), { status: 200 })
          : new Response(null, { status: 404 }),
      );
    }),
  );
  return server;
}

/** A job feed the test drives, like the live store's `onJobChanged`. */
function jobFeed() {
  const listeners = new Set<(job: Job) => void>();
  return {
    onJobChanged: (listener: (job: Job) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(id: number, state: JobState) {
      for (const l of listeners) l({ id, kind: "pitchTrack", state });
    },
    get listening() {
      return listeners.size;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function start(answer: unknown, frames = true) {
  const server = fakeServer(answer, frames);
  const feed = jobFeed();
  const states: PitchTrackLoad[] = [];
  const controller = new AbortController();
  loadPitchTrack(
    7,
    { onJobChanged: feed.onJobChanged, signal: controller.signal },
    (s) => states.push(s),
  );
  await settle();
  await settle();
  return { server, feed, states, controller };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loading a Song's Pitch track", () => {
  it("downloads a cached track at once", async () => {
    const { server, states, feed } = await start({ state: "ready" });

    expect(server.calls).toEqual([
      "POST /api/songs/7/pitch-track",
      "GET /api/songs/7/pitch-track",
    ]);
    const last = states.at(-1);
    expect(last?.state).toBe("ready");
    if (last?.state === "ready")
      expect(Array.from(last.track.pitch)).toEqual([440, 0]);
    expect(feed.listening).toBe(0);
  });

  it("follows the job's progress and downloads the track when it is done", async () => {
    const { server, states, feed } = await start({
      state: "computing",
      job: 3,
    });
    expect(states).toEqual([{ state: "listening", percent: null }]);

    feed.send(9, { type: "running", percent: 90 }); // another job
    feed.send(3, { type: "running", percent: 40 });
    expect(states.at(-1)).toEqual({ state: "listening", percent: 40 });
    expect(server.calls).toHaveLength(1);

    feed.send(3, { type: "done" });
    await settle();
    await settle();
    expect(server.calls.at(-1)).toBe("GET /api/songs/7/pitch-track");
    expect(states.at(-1)?.state).toBe("ready");
    expect(feed.listening).toBe(0);
  });

  it("does not miss a job that finished before the answer arrived", async () => {
    const server = fakeServer({ state: "computing", job: 3 });
    const feed = jobFeed();
    const states: PitchTrackLoad[] = [];
    loadPitchTrack(
      7,
      { onJobChanged: feed.onJobChanged, signal: new AbortController().signal },
      (s) => states.push(s),
    );
    feed.send(3, { type: "done" });
    for (let i = 0; i < 4; i++) await settle();

    expect(server.calls.at(-1)).toBe("GET /api/songs/7/pitch-track");
    expect(states.at(-1)?.state).toBe("ready");
  });

  it("reports the job's failure", async () => {
    const { states, feed } = await start({ state: "computing", job: 3 });
    feed.send(3, { type: "failed", reason: { code: "pitchTrackFailed" } });
    expect(states.at(-1)).toEqual({
      state: "failed",
      reason: { code: "pitchTrackFailed" },
    });
    expect(feed.listening).toBe(0);
  });

  it('fails as "couldn\'t listen" when the track cannot be downloaded', async () => {
    const { states } = await start({ state: "ready" }, false);
    expect(states.at(-1)).toEqual({
      state: "failed",
      reason: { code: "pitchTrackFailed" },
    });
  });

  it("stops listening and reports nothing once aborted", async () => {
    const { states, feed, controller } = await start({
      state: "computing",
      job: 3,
    });
    controller.abort();
    feed.send(3, { type: "running", percent: 50 });
    expect(states).toHaveLength(1);
    expect(feed.listening).toBe(0);
  });
});
