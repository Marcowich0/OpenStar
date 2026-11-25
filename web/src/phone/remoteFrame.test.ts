import { describe, expect, it } from "vitest";

import type { LineUp } from "../generated/LineUp";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { Request } from "../generated/Request";
import { defaultTab, queueCount, statusStrip } from "./remoteFrame";

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
  seats: [],
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
};

/** The head's Line-up waits for Start. */
const waiting: PartySnapshot = {
  ...idle,
  queue: [request(1, 40), request(2, 41)],
  head: 1,
  lineUp,
};

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

  it("is never shown on the Stage tab", () => {
    expect(statusStrip(waiting, "stage")).toBeNull();
  });

  it("is hidden in any other state", () => {
    expect(statusStrip(idle, "songs")).toBeNull();
    expect(statusStrip(null, "songs")).toBeNull();
    expect(
      statusStrip({ ...idle, queue: [request(1, 40)], head: 1 }, "queue"),
    ).toBeNull();
  });
});

describe("the Queue tab's badge", () => {
  it("counts every Request in the Queue", () => {
    expect(queueCount(waiting)).toBe(2);
    expect(queueCount(idle)).toBe(0);
    expect(queueCount(null)).toBe(0);
  });
});
