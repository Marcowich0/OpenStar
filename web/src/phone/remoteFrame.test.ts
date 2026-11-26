import { describe, expect, it } from "vitest";

import type { LineUp } from "../generated/LineUp";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { Request } from "../generated/Request";
import { defaultTab, queueCount, stageCard, statusStrip } from "./remoteFrame";

const request = (requestId: number, songId: number): Request => ({
  requestId,
  kind: "song",
  songId,
  requestedPlayers: [],
  adder: null,
});

const lineUp: LineUp = {
  requestId: 1,
  duet: false,
  seats: [
    { memberId: 3, mic: null, voice: "p1", difficulty: "easy" },
    { memberId: 5, mic: null, voice: "p1", difficulty: "hard" },
  ],
  canStart: false,
  warnings: [],
};

const idle: PartySnapshot = {
  partyId: "p",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members: [],
  phones: [],
  queue: [],
  head: null,
  lineUp: null,
  playing: null,
  results: null,
  localMics: [],
};

/** The head's Line-up waits for Start. */
const waiting: PartySnapshot = {
  ...idle,
  queue: [request(1, 40), request(2, 41)],
  head: 1,
  lineUp,
};

/** The head's Song plays (or is paused, with `paused`). */
const playing = (paused = false): PartySnapshot => ({
  ...waiting,
  lineUp: { ...lineUp, canStart: false },
  playing: { requestId: 1, songId: 40, paused },
});

/** The Stage shows the results of Request 1; `queue` is what is left. */
const results = (queue: Request[]): PartySnapshot => ({
  ...idle,
  queue,
  results: { requestId: 1, songId: 40, ended: "played", players: [] },
});

describe("what the Stage is doing", () => {
  it("is the results, with Next Song while Requests are left", () => {
    expect(stageCard(results([request(2, 41)]))).toEqual({
      kind: "results",
      songId: 40,
      queueEmpty: false,
    });
  });

  it("is the results, with Done when the Queue holds nothing more", () => {
    expect(stageCard(results([]))).toEqual({
      kind: "results",
      songId: 40,
      queueEmpty: true,
    });
  });

  it("is the playing Song with its Players, in seat order", () => {
    expect(stageCard(playing())).toEqual({
      kind: "playing",
      requestId: 1,
      songId: 40,
      paused: false,
      players: [3, 5],
    });
    expect(stageCard(playing(true))).toMatchObject({ paused: true });
  });

  it("is the waiting Line-up while its Song has not started", () => {
    expect(stageCard(waiting)).toEqual({ kind: "lineUp", songId: 40 });
  });

  it("is waiting with an empty Queue", () => {
    expect(stageCard(idle)).toEqual({ kind: "empty" });
  });

  it("is unknown before the Party is known", () => {
    expect(stageCard(null)).toBeNull();
  });
});

describe("the Remote's default tab", () => {
  it("is the Stage tab while a Line-up waits", () => {
    expect(defaultTab(waiting)).toBe("stage");
  });

  it("is Songs with an empty Queue", () => {
    expect(defaultTab(idle)).toBe("songs");
  });

  it("is Songs while Requests wait but no Line-up does", () => {
    expect(defaultTab({ ...idle, queue: [request(1, 40)] })).toBe("songs");
  });

  it("is Songs while a Song plays", () => {
    expect(defaultTab(playing())).toBe("songs");
  });

  it("is Songs before the Party is known", () => {
    expect(defaultTab(null)).toBe("songs");
  });
});

describe("the status strip", () => {
  it("shows the Line-up's Song while a Line-up waits", () => {
    expect(statusStrip(waiting, "songs")).toEqual({
      kind: "lineUp",
      songId: 40,
    });
    expect(statusStrip(waiting, "people")).toEqual({
      kind: "lineUp",
      songId: 40,
    });
  });

  it("shows the playing Song, its Players and whether it is paused", () => {
    expect(statusStrip(playing(), "songs")).toEqual({
      kind: "playing",
      requestId: 1,
      songId: 40,
      paused: false,
      players: [3, 5],
    });
    expect(statusStrip(playing(true), "queue")).toMatchObject({
      kind: "playing",
      paused: true,
    });
  });

  it("is never shown on the Stage tab", () => {
    expect(statusStrip(waiting, "stage")).toBeNull();
    expect(statusStrip(playing(), "stage")).toBeNull();
  });

  it("is hidden in any other state", () => {
    expect(statusStrip(idle, "songs")).toBeNull();
    expect(statusStrip(null, "songs")).toBeNull();
    expect(
      statusStrip({ ...idle, queue: [request(1, 40)], head: 1 }, "queue"),
    ).toBeNull();
    expect(statusStrip(results([]), "songs")).toBeNull();
  });
});

describe("the Queue tab's badge", () => {
  it("counts every Request in the Queue", () => {
    expect(queueCount(waiting)).toBe(2);
    expect(queueCount(idle)).toBe(0);
    expect(queueCount(null)).toBe(0);
  });
});
