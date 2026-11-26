import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fitCases,
  melodySong,
  sungTrack,
  type FitCase,
} from "../../fit/fitFixtures";
import type { Job } from "../../generated/Job";
import type { JobState } from "../../generated/JobState";
import type { SongDetail } from "../../generated/SongDetail";
import type { SongSummary } from "../../generated/SongSummary";
import type { TimingSave } from "../../generated/TimingSave";
import { fakeLibraryServer, renderLive, settle } from "../adminTestKit";
import { AdminSongRow } from "../Songs";
import { PhoneAutoFit } from "./PhoneAutoFit";

const ADMIN_PIN = "4321";
const BASE = "a".repeat(64);
const PHONE = "4b1d8f0e-0000-4000-8000-000000000223";

const summary = {
  id: 7,
  path: "Nobody - Placeholder/song.txt",
  artist: "Nobody",
  title: "Placeholder",
  duet: false,
  identity: {
    kind: "artistTitle",
    artist: "Nobody",
    title: "Placeholder",
    duet: false,
  },
  lengthSeconds: 30,
  hasVideo: false,
  preparing: false,
  cover: null,
  tileColour: "teal",
  topHighScore: null,
  year: null,
} satisfies SongSummary;

function detail(c: FitCase): SongDetail {
  return {
    id: 7,
    path: summary.path,
    song: melodySong(c),
    noteFingerprint: "f",
    identity: summary.identity,
    lengthSeconds: c.seconds,
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

function trackBytes(c: FitCase): ArrayBuffer {
  const { pitch } = sungTrack(c);
  const view = new DataView(new ArrayBuffer(pitch.length * 12));
  pitch.forEach((hz, i) => {
    view.setFloat32(i * 12, hz, true);
    view.setFloat32(i * 12 + 8, hz > 0 ? 0.2 : 0, true);
  });
  return view.buffer;
}

interface Options {
  unlocked?: boolean;
  start?: unknown;
  c?: FitCase;
}

function server({
  unlocked = false,
  start = { state: "ready" },
  c = fitCases.gapAndBpmError,
}: Options = {}) {
  const state = { unlocked, saved: [] as TimingSave[] };
  const refuse = () =>
    new Response(JSON.stringify({ code: "unlockRequired" }), { status: 401 });
  const fake = fakeLibraryServer({
    "GET /api/unlock": () => ({ unlocked: state.unlocked }),
    "POST /api/unlock": (_url: URL, init: RequestInit) => {
      const { pin } = JSON.parse(init.body as string) as { pin: string };
      if (pin !== ADMIN_PIN)
        return new Response(JSON.stringify({ code: "wrongPin" }), {
          status: 403,
        });
      state.unlocked = true;
      return { unlocked: true };
    },
    "POST /api/songs/7/auto-fit": () => (state.unlocked ? start : refuse()),
    "GET /api/songs/7": detail(c),
    "GET /api/songs/7/pitch-track": () =>
      new Response(trackBytes(c), { status: 200 }),
    "POST /api/songs/7/timing/preview": { base: BASE, changed: [] },
    "POST /api/songs/7/timing": (_url: URL, init: RequestInit) => {
      if (!state.unlocked) return refuse();
      state.saved.push(JSON.parse(init.body as string) as TimingSave);
      return { base: "b".repeat(64), changed: [] };
    },
  });
  return { fake, state };
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

async function open(options: Options = {}) {
  const { fake, state } = server(options);
  const feed = jobFeed();
  await renderLive(
    <ul>
      <PhoneAutoFit song={summary} store={feed} phoneId={PHONE}>
        {(control, details) => (
          <AdminSongRow song={summary} below={details}>
            {control}
          </AdminSongRow>
        )}
      </PhoneAutoFit>
    </ul>,
  );
  return { fake, state, feed };
}

function press(name: string | RegExp) {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

async function enterPin(pin: string) {
  for (const digit of pin) press(digit);
  const ok = screen.getByRole("button", { name: "OK" });
  act(() => {
    fireEvent.pointerDown(ok, { pointerType: "mouse" });
    fireEvent.pointerUp(ok, { pointerType: "mouse" });
    fireEvent.click(ok);
  });
  await settle();
}

const fitButton = () =>
  screen.queryByRole("button", { name: "Fit to the singing" });
const pad = () => screen.queryByRole("dialog", { name: "Admin PIN" });
const proposal = () => screen.getByRole("region", { name: "Auto-fit" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Fit to the singing on a Phone", () => {
  it("asks for the Admin PIN first without an Unlock, then starts the guarded fit", async () => {
    const { fake } = await open();
    press("Fit to the singing");
    await settle();
    expect(pad()).not.toBeNull();
    expect(fake.calls).not.toContain("GET /api/songs/7/pitch-track");

    await enterPin(ADMIN_PIN);
    await settle();
    expect(pad()).toBeNull();
    expect(fake.count("POST /api/songs/7/auto-fit")).toBe(2);
    expect(fake.calls).not.toContain("POST /api/songs/7/pitch-track");
    expect(proposal()).toHaveTextContent(/Notes on the singing/);
  });

  it("does nothing when the PIN pad is cancelled", async () => {
    const { fake } = await open();
    press("Fit to the singing");
    await settle();
    press("Cancel");
    await settle();
    expect(fitButton()).toBeEnabled();
    expect(fake.calls).not.toContain("GET /api/songs/7/pitch-track");
  });

  it("becomes a pill with the job's progress while the song is listened to", async () => {
    const { feed } = await open({
      unlocked: true,
      start: { state: "computing", job: 3 },
    });
    press("Fit to the singing");
    await settle();
    expect(fitButton()).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Listening to the song…",
    );

    await feed.send({ type: "running", percent: 40 });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Listening to the song… 40 %",
    );

    await feed.send({ type: "done" });
    expect(proposal()).toHaveTextContent(/tempo .* slower/);
  });

  it("proposes the fit in the desktop's plain words with Accept and Undo", async () => {
    await open({ unlocked: true });
    press("Fit to the singing");
    await settle();
    expect(proposal()).toHaveTextContent(
      /notes 2\.9 s earlier \(GAP 3,650 → \d+ ms\), tempo 0\.53 % slower \(BPM 217\.4 → 216\.2\d\)/,
    );
    expect(proposal()).toHaveTextContent(
      /Notes on the singing \d+ % → \d+ %\. Accept to save it, or Undo\./,
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    // A Phone offers no offset only, no Lines still off and no editor.
    expect(screen.queryByRole("button", { name: "offset only" })).toBeNull();
    expect(screen.queryByText("Lines still off")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("Accept saves #GAP and #BPM through the guarded save, naming this Phone", async () => {
    const { state, fake } = await open({ unlocked: true });
    press("Fit to the singing");
    await settle();
    press("Accept");
    await settle();

    expect(fake.count("POST /api/songs/7/timing")).toBe(1);
    const [saved] = state.saved;
    expect(saved?.base).toBe(BASE);
    expect(saved?.autoFitFrom).toBe(PHONE);
    expect(saved?.operations.map((o) => o.op)).toEqual(["setGap", "setBpm"]);
    expect(screen.queryByRole("region", { name: "Auto-fit" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Fit saved. Restore Original takes it back.",
    );
  });

  it("Undo drops the proposal and writes nothing", async () => {
    const { fake } = await open({ unlocked: true });
    press("Fit to the singing");
    await settle();
    press("Undo");
    await settle();

    expect(screen.queryByRole("region", { name: "Auto-fit" })).toBeNull();
    expect(fitButton()).toBeEnabled();
    expect(fake.calls).not.toContain("POST /api/songs/7/timing");
  });

  it("says it is already the best fit and offers nothing to accept", async () => {
    await open({ unlocked: true, c: fitCases.alreadyBest });
    press("Fit to the singing");
    await settle();
    expect(proposal()).toHaveTextContent(
      "Already the best fit the editor can find.",
    );
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("says it couldn't listen and offers nothing to accept", async () => {
    const { feed } = await open({
      unlocked: true,
      start: { state: "computing", job: 3 },
    });
    press("Fit to the singing");
    await settle();
    await feed.send({ type: "failed", reason: { code: "pitchTrackFailed" } });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't listen to this Song",
    );
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(fitButton()).toBeEnabled();
  });
});
