import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../api/queryClient";
import type { Job } from "../../generated/Job";
import type { JobState } from "../../generated/JobState";
import type { LibraryReadOnly } from "../../generated/LibraryReadOnly";
import type { TimingOperation } from "../../generated/TimingOperation";
import type { TimingSave } from "../../generated/TimingSave";
import type { SongDetail } from "../../generated/SongDetail";
import {
  fitCases,
  melody,
  melodySong,
  sungTrack,
  type FitCase,
} from "../../fit/fitFixtures";
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

interface ServerOptions {
  unlocked?: boolean;
  libraryReadOnly?: LibraryReadOnly | null;
  /** The file changed on disk: preview and save answer `409 songFileChanged`. */
  conflict?: boolean;
  /** The Song and its Pitch track, when not the two-Note Song above. */
  detail?: SongDetail;
  track?: ArrayBuffer;
}

interface Server {
  calls: string[];
  /** The JSON bodies sent, by `"METHOD /path"`, in order. */
  bodies: Record<string, unknown[]>;
  unlocked: boolean;
  conflict: boolean;
}

const ADMIN_PIN = "4321";
const FILE_VERSION = "a".repeat(64);
const SAVED_VERSION = "b".repeat(64);

/**
 * What the patcher would change for `operations` in the test Song's file
 * (`#GAP` on line 3, `#BPM` on line 4); a stand-in for the server's.
 */
function changedLines(operations: TimingOperation[]) {
  const changed = new Map<number, { line: number; old: string; new: string }>();
  for (const op of operations) {
    if (op.op === "setGap")
      changed.set(3, {
        line: 3,
        old: "#GAP:0",
        new: `#GAP:${String(Math.round(op.seconds * 1000))}`,
      });
    if (op.op === "setBpm")
      changed.set(4, {
        line: 4,
        old: "#BPM:150",
        new: `#BPM:${String(op.beatsPerMinute / 4)}`,
      });
  }
  return [...changed.values()].filter((c) => c.old !== c.new);
}

function fakeServer(start: unknown, options: ServerOptions = {}): Server {
  const server: Server = {
    calls: [],
    bodies: {},
    unlocked: options.unlocked ?? false,
    conflict: options.conflict ?? false,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      const route = `${method} ${input}`;
      server.calls.push(route);
      const body =
        typeof init.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : null;
      (server.bodies[route] ??= []).push(body);
      const json = (status: number, answer: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(answer), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
        );
      switch (route) {
        case "GET /api/songs/7":
          return json(200, options.detail ?? detail());
        case "POST /api/songs/7/pitch-track":
          return json(200, start);
        case "GET /api/songs/7/pitch-track":
          return Promise.resolve(
            new Response(options.track ?? trackBytes(), { status: 200 }),
          );
        case "GET /api/server-info":
          return json(200, {
            version: "dev",
            schemaVersion: 1,
            libraryReadOnly: options.libraryReadOnly ?? null,
            publicUrl: null,
          });
        case "GET /api/unlock":
          return json(200, { unlocked: server.unlocked });
        case "POST /api/unlock": {
          const { pin } = body as { pin: string };
          if (pin !== ADMIN_PIN) return json(403, { code: "wrongPin" });
          server.unlocked = true;
          return json(200, { unlocked: true });
        }
        case "POST /api/songs/7/timing/preview": {
          if (server.conflict) return json(409, { code: "songFileChanged" });
          const { operations } = body as { operations: TimingOperation[] };
          return json(200, {
            base: FILE_VERSION,
            changed: changedLines(operations),
          });
        }
        case "POST /api/songs/7/timing": {
          if (!server.unlocked) return json(401, { code: "unlockRequired" });
          if (server.conflict) return json(409, { code: "songFileChanged" });
          const { operations } = body as TimingSave;
          return json(200, {
            base: SAVED_VERSION,
            changed: changedLines(operations),
          });
        }
        default:
          return Promise.resolve(new Response(null, { status: 404 }));
      }
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

async function open(
  start: unknown = { state: "ready" },
  options: ServerOptions = {},
) {
  const server = fakeServer(start, options);
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

  it("never changes the Song: nothing but the Song, its Pitch track and the server's state is asked for", async () => {
    const { server } = await open();
    expect([...new Set(server.calls)].sort()).toEqual([
      "GET /api/server-info",
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

const gapField = () => screen.getByRole("textbox", { name: "#GAP (ms)" });
const bpmField = () => screen.getByRole("textbox", { name: "#BPM" });
const editList = () => screen.getByRole("list", { name: "Edits" });
const preview = () => screen.getByRole("region", { name: "What Save changes" });
const saveButton = () => screen.getByRole("button", { name: "Save" });

async function type(field: HTMLElement, value: string) {
  act(() => {
    fireEvent.change(field, { target: { value } });
    fireEvent.keyDown(field, { key: "Enter" });
  });
  await settle();
}

function press(name: string) {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

async function key(init: KeyboardEventInit) {
  act(() => {
    fireEvent.keyDown(window, init);
  });
  await settle();
}

function pressOk() {
  const ok = screen.getByRole("button", { name: "OK" });
  act(() => {
    fireEvent.pointerDown(ok, { pointerType: "mouse" });
    fireEvent.pointerUp(ok, { pointerType: "mouse" });
    fireEvent.click(ok);
  });
}

async function enterPin(pin: string) {
  for (const digit of pin) press(digit);
  pressOk();
  await settle();
}

const entries = () =>
  Array.from(editList().querySelectorAll("li")).map((li) => ({
    text: li.textContent,
    undone: li.querySelector("del") !== null,
  }));

describe("typing #GAP and #BPM", () => {
  it("adds an edit, rounded to whole ms, and moves the Notes", async () => {
    await open();
    expect(gapField()).toHaveValue("0");
    expect(screen.queryByText("file: 0")).toBeNull();

    await type(gapField(), "1000.4");

    expect(gapField()).toHaveValue("1000");
    expect(screen.getByText("file: 0")).toBeInTheDocument();
    expect(entries()).toEqual([
      { text: "GAP typed: 0 → 1,000 ms", undone: false },
    ]);
    // The first Note now sits at 1–2 s, where nothing is sung: the share
    // falls, and the file's own share shows beside it.
    expect(share()).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("file: 50 %")).toBeInTheDocument();
  });

  it("rounds #BPM to two decimals and shows the file's value", async () => {
    await open();
    expect(bpmField()).toHaveValue("150");
    await type(bpmField(), "151.456");
    expect(bpmField()).toHaveValue("151.46");
    expect(screen.getByText("file: 150")).toBeInTheDocument();
    expect(entries()).toEqual([
      { text: "BPM typed: 150 → 151.46", undone: false },
    ]);
  });

  it("ignores a value that is not a number", async () => {
    await open();
    await type(gapField(), "soon");
    expect(gapField()).toHaveValue("0");
    expect(entries()).toEqual([]);
  });
});

describe("the edit list", () => {
  it("undoes and redoes by button, striking undone edits until a new edit clears them", async () => {
    await open();
    await type(gapField(), "100");
    await type(gapField(), "200");

    press("Undo");
    await settle();
    expect(gapField()).toHaveValue("100");
    expect(entries()).toEqual([
      { text: "GAP typed: 0 → 100 ms", undone: false },
      { text: "GAP typed: 100 → 200 ms", undone: true },
    ]);

    press("Redo");
    await settle();
    expect(gapField()).toHaveValue("200");
    expect(entries().map((e) => e.undone)).toEqual([false, false]);

    press("Undo");
    await settle();
    await type(bpmField(), "160");
    expect(entries()).toEqual([
      { text: "GAP typed: 0 → 100 ms", undone: false },
      { text: "BPM typed: 150 → 160", undone: false },
    ]);
  });

  it("undoes with Ctrl/Cmd+Z and redoes with Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y", async () => {
    await open();
    await type(gapField(), "100");

    await key({ key: "z", ctrlKey: true });
    expect(gapField()).toHaveValue("0");
    await key({ key: "Z", metaKey: true, shiftKey: true });
    expect(gapField()).toHaveValue("100");
    await key({ key: "z", metaKey: true });
    expect(gapField()).toHaveValue("0");
    await key({ key: "y", ctrlKey: true });
    expect(gapField()).toHaveValue("100");
  });

  it("goes back to the file, dropping every edit", async () => {
    await open();
    await type(gapField(), "100");
    await type(bpmField(), "160");
    press("Undo");
    await settle();

    press("Back to the file");
    await settle();
    expect(gapField()).toHaveValue("0");
    expect(bpmField()).toHaveValue("150");
    expect(entries()).toEqual([]);
  });
});

describe("the save preview", () => {
  it("says nothing would change before any edit", async () => {
    await open();
    expect(preview()).toHaveTextContent(
      "nothing: the file would stay as it is",
    );
    expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("asks the server with the current operations and lists only the lines that change", async () => {
    const { server } = await open();
    await type(gapField(), "753");
    await type(bpmField(), "216.26");

    expect(server.bodies["POST /api/songs/7/timing/preview"]?.at(-1)).toEqual({
      operations: [
        { op: "setGap", seconds: 0.753 },
        { op: "setBpm", beatsPerMinute: 865.04 },
      ],
    });
    const rows = within(preview()).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "3#GAP:0#GAP:753",
      "4#BPM:150#BPM:216.26",
    ]);
    expect(preview()).toHaveTextContent(
      "2 lines changed, everything else byte for byte",
    );
  });

  it("says nothing would change when the edits come back to the file's values", async () => {
    await open();
    await type(gapField(), "100");
    await type(gapField(), "0");
    expect(preview()).toHaveTextContent(
      "nothing: the file would stay as it is",
    );
  });
});

describe("saving a Timing edit", () => {
  it("asks for the Admin PIN without an Unlock, then saves the operations against the previewed file", async () => {
    const { server } = await open();
    await type(gapField(), "753");

    press("Save");
    await settle();
    expect(screen.getByRole("dialog", { name: "Admin PIN" })).toBeVisible();
    await enterPin(ADMIN_PIN);

    expect(server.bodies["POST /api/songs/7/timing"]?.at(-1)).toEqual({
      base: FILE_VERSION,
      operations: [{ op: "setGap", seconds: 0.753 }],
    });
    // The saved file is the new base: no edits, no "file:" values.
    expect(entries()).toEqual([]);
    expect(gapField()).toHaveValue("753");
    expect(screen.queryByText("file: 0")).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("status", { name: "Saved" })).toHaveTextContent(
      "Saved: 1 line changed",
    );
  });

  it("goes straight through with an Unlock", async () => {
    const { server } = await open({ state: "ready" }, { unlocked: true });
    await type(gapField(), "753");
    press("Save");
    await settle();
    expect(screen.queryByRole("dialog", { name: "Admin PIN" })).toBeNull();
    expect(server.calls).toContain("POST /api/songs/7/timing");
    expect(entries()).toEqual([]);
  });

  it("shows the conflict when the file changed since it was loaded, and keeps the edits", async () => {
    const { server } = await open({ state: "ready" }, { unlocked: true });
    await type(gapField(), "753");
    server.conflict = true;

    press("Save");
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This Song's file changed on disk since it was opened",
    );
    expect(entries()).toHaveLength(1);
  });

  it("is disabled with the read-only notice when the Library is read-only", async () => {
    const { server } = await open(
      { state: "ready" },
      {
        unlocked: true,
        libraryReadOnly: { code: "songsFolderNotWritable", songsDir: "/songs" },
      },
    );
    await type(gapField(), "753");

    expect(
      screen.getByText(
        "OpenStar cannot write to the songs folder /songs, so the Library is read-only",
      ),
    ).toBeInTheDocument();
    expect(saveButton()).toHaveAttribute("aria-disabled", "true");
    press("Save");
    await settle();
    expect(server.calls).not.toContain("POST /api/songs/7/timing");
  });
});

/** The detail of a fit case's Song (`fixtures/fit/`) and its Pitch track's bytes. */
function fitCase(c: FitCase): ServerOptions {
  const { pitch } = sungTrack(c);
  const view = new DataView(new ArrayBuffer(pitch.length * 12));
  pitch.forEach((hz, i) => {
    view.setFloat32(i * 12, hz, true);
    view.setFloat32(i * 12 + 8, hz > 0 ? 0.2 : 0, true);
  });
  return {
    detail: { ...detail(), song: melodySong(c), lengthSeconds: c.seconds },
    track: view.buffer,
  };
}

const fitButton = () =>
  screen.getByRole("button", { name: "Fit to the singing" });
const offsetOnlyButton = () =>
  screen.getByRole("button", { name: "offset only" });
const fitResult = () => screen.getByRole("region", { name: "Auto-fit" });
const linesStillOff = () =>
  screen.getByRole("list", { name: "Lines still off" });

describe("Auto-fit", () => {
  it("is disabled until the Pitch track is ready", async () => {
    const { feed } = await open(
      { state: "computing", job: 3 },
      fitCase(fitCases.gapAndBpmError),
    );
    expect(fitButton()).toBeDisabled();
    expect(offsetOnlyButton()).toBeDisabled();

    await feed.send({ type: "done" });
    expect(fitButton()).toBeEnabled();
    expect(offsetOnlyButton()).toBeEnabled();
  });

  it("Fit to the singing applies #GAP and #BPM as one undoable edit and says so in plain words", async () => {
    await open({ state: "ready" }, fitCase(fitCases.gapAndBpmError));
    press("Fit to the singing");
    await settle();

    const gap = Number(gapField().getAttribute("value"));
    const bpm = Number(bpmField().getAttribute("value"));
    expect(Math.abs(gap - 753)).toBeLessThanOrEqual(10);
    expect(Math.abs(bpm - 216.26)).toBeLessThanOrEqual(0.01);
    expect(entries()).toEqual([
      {
        text: `Fit to the singing: GAP 3,650 → ${String(gap)} ms, BPM 217.4 → ${String(bpm)}`,
        undone: false,
      },
    ]);
    expect(fitResult()).toHaveTextContent(
      /notes 2\.9 s earlier \(GAP 3,650 → \d+ ms\), tempo 0\.53 % slower \(BPM 217\.4 → 216\.2\d\)/,
    );
    expect(fitResult()).toHaveTextContent(
      /Notes on the singing \d+ % → \d+ %\. Play a few Lines to check, or Undo\./,
    );

    press("Undo");
    await settle();
    expect(gapField()).toHaveValue("3650");
    expect(bpmField()).toHaveValue("217.4");
  });

  it("offset only changes #GAP and keeps #BPM", async () => {
    await open({ state: "ready" }, fitCase(fitCases.gapAndBpmError));
    press("offset only");
    await settle();
    expect(gapField()).not.toHaveValue("3650");
    expect(bpmField()).toHaveValue("217.4");
    expect(entries()).toHaveLength(1);
    expect(entries()[0]?.text).toMatch(/^Fit, offset only: GAP 3,650 → /);
    expect(fitResult()).not.toHaveTextContent("tempo");
  });

  it("applies nothing when the search returns the current values", async () => {
    await open({ state: "ready" }, fitCase(fitCases.alreadyBest));
    press("Fit to the singing");
    await settle();
    expect(fitResult()).toHaveTextContent(
      "Already the best fit the editor can find.",
    );
    expect(entries()).toEqual([]);
    expect(
      screen.getByText("No single Line stands out after the fit."),
    ).toBeInTheDocument();
  });

  it("after a fit alone, the save preview lists only the #GAP and #BPM lines", async () => {
    const { server } = await open(
      { state: "ready" },
      fitCase(fitCases.gapAndBpmError),
    );
    press("Fit to the singing");
    await settle();
    const sent = server.bodies["POST /api/songs/7/timing/preview"]?.at(-1) as {
      operations: TimingOperation[];
    };
    expect(sent.operations.map((o) => o.op)).toEqual(["setGap", "setBpm"]);
    const rows = within(preview()).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.firstChild?.textContent)).toEqual(["3", "4"]);
  });
});

describe("Lines still off", () => {
  async function fitted() {
    await open({ state: "ready" }, fitCase(fitCases.oneLineLate));
    press("offset only");
    await settle();
  }
  const item = () => within(linesStillOff()).getByRole("listitem");

  it("lists each Line with its number, the start of its lyric, the Beats and the shares", async () => {
    await fitted();
    expect(within(linesStillOff()).getAllByRole("listitem")).toHaveLength(1);
    expect(item()).toHaveTextContent(
      /^Line 6 “la la la la la…” \+2 beats \(\d+ → \d+ %\)/,
    );
  });

  it("Go seeks to 1.5 s before the Line and selects it", async () => {
    await fitted();
    act(() => {
      fireEvent.click(within(item()).getByRole("button", { name: "Go" }));
    });
    await settle();
    const gapSeconds = Number(gapField().getAttribute("value")) / 1000;
    const bpm = Number(bpmField().getAttribute("value"));
    const firstBeat = melody.find((n) => n.line === 5)?.start ?? 0;
    const lineStart = gapSeconds + (firstBeat * 15) / bpm;
    expect(Number(detailCanvas().getAttribute("data-playhead"))).toBeCloseTo(
      lineStart - 1.5,
      5,
    );
    expect(detailCanvas()).toHaveAttribute("data-selection", "0:5-5");
  });

  it("Apply shifts that Line by the suggested Beats as one undoable edit and takes it off the list", async () => {
    await fitted();
    const before = entries().length;
    act(() => {
      fireEvent.click(within(item()).getByRole("button", { name: "Apply" }));
    });
    await settle();
    expect(entries()).toHaveLength(before + 1);
    expect(entries().at(-1)?.text).toBe("Line 6: +2 beats");
    expect(
      screen.getByText("No single Line stands out after the fit."),
    ).toBeInTheDocument();

    press("Undo");
    await settle();
    expect(entries().at(-1)?.undone).toBe(true);
  });
});
