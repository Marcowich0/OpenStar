import { describe, expect, it } from "vitest";

import type { PartySnapshot } from "../generated/PartySnapshot";
import type { ServerMessage } from "../generated/ServerMessage";
import { connectionChanged, initialLiveState, receive } from "./liveState";

const party: PartySnapshot = {
  partyId: "p1",
  stageId: "main",
  joinCode: "0427",
  startedAtMs: 1000,
  members: [],
  phones: [],
  queue: [],
  head: null,
  lineUp: null,
  playing: null,
  results: null,
};

const synced = (isStage: boolean, current: PartySnapshot | null = party) =>
  receive(initialLiveState, {
    type: "liveState",
    stageId: "main",
    party: current,
    isStage,
  });

const started = (next: PartySnapshot): ServerMessage => ({
  type: "partyChanged",
  party: next,
  change: {
    actor: { kind: "stage" },
    event: { code: "partyStarted", params: { joinCode: next.joinCode } },
  },
});

describe("live state reducer", () => {
  it("knows nothing of this browser's Phone until the server says", () => {
    expect(initialLiveState.phone).toBeNull();
    expect(initialLiveState.validJoinCode).toBeNull();
  });

  it("takes the Party member this Phone uses from its status", () => {
    const joined = receive(synced(false), {
      type: "phoneStatus",
      memberId: 3,
    });
    expect(joined.phone).toEqual({ memberId: 3, leftParty: false });
    const notIn = receive(synced(false), {
      type: "phoneStatus",
      memberId: null,
    });
    expect(notIn.phone).toEqual({ memberId: null, leftParty: false });
  });

  it("marks a Phone that left the Party, until its next status", () => {
    const joined = receive(synced(false), { type: "phoneStatus", memberId: 3 });
    const left = receive(joined, { type: "leftParty" });
    expect(left.phone).toEqual({ memberId: null, leftParty: true });
    const again = receive(left, { type: "phoneStatus", memberId: 1 });
    expect(again.phone).toEqual({ memberId: 1, leftParty: false });
  });

  it("keeps the Join code the server confirmed", () => {
    const checked = receive(synced(false), {
      type: "joinCodeValid",
      joinCode: "0427",
    });
    expect(checked.validJoinCode).toBe("0427");
  });

  it("takes the whole Stage state from the live-state message", () => {
    expect(synced(true).stage).toEqual({
      stageId: "main",
      party,
      isStage: true,
      stageMoved: false,
    });
    expect(synced(false, null).stage?.party).toBeNull();
  });

  it("takes the whole Party and a toast from a Party change", () => {
    const next = { ...party, partyId: "p2", joinCode: "9133" };
    const message = started(next);
    const changed = receive(synced(false), message);
    expect(changed.stage?.party).toEqual(next);
    expect(changed.toasts).toEqual([
      {
        id: 0,
        actor: { kind: "stage" },
        event: { code: "partyStarted", params: { joinCode: "9133" } },
      },
    ]);
  });

  it("ignores a Party change for another Stage", () => {
    const state = synced(false);
    expect(receive(state, started({ ...party, stageId: "other" }))).toEqual(
      state,
    );
  });

  it("stops being the Stage when the Stage moves, and keeps the Party", () => {
    const moved = receive(synced(true), { type: "stageMoved" });
    expect(moved.stage).toEqual({
      stageId: "main",
      party,
      isStage: false,
      stageMoved: true,
    });
  });

  it("keeps the last rejection as a code with its parameters", () => {
    const state = receive(initialLiveState, {
      type: "rejected",
      reason: { code: "notTheStage" },
    });
    expect(state.lastRejection).toEqual({ code: "notTheStage" });
  });

  it("records the nonce of the last pong", () => {
    expect(receive(initialLiveState, { type: "pong", nonce: 7 }).lastPong).toBe(
      7,
    );
  });

  it("leaves the state alone on a change notice", () => {
    expect(receive(initialLiveState, { type: "changed", topics: [] })).toBe(
      initialLiveState,
    );
  });

  it("leaves the state alone on relayed Pitch readings, clock sync and Mic-closed notices", () => {
    const state = synced(true);
    const mic = { kind: "phone", connection: 4 } as const;
    const relayed: ServerMessage[] = [
      {
        type: "pitchReading",
        mic,
        reading: { captureMs: 10, pitch: 69, clarity: 0.9, loudness: -20 },
      },
      { type: "clockPing", mic, t0: 1 },
      { type: "clockPong", t0: 1, ts: 2, epoch: 3 },
      { type: "micClosed", mic },
    ];
    for (const message of relayed) {
      expect(receive(state, message)).toBe(state);
    }
  });

  it("keeps the last known Stage state while reconnecting", () => {
    const open = receive(connectionChanged(initialLiveState, "open"), {
      type: "liveState",
      stageId: "main",
      party,
      isStage: false,
    });
    const reconnecting = connectionChanged(open, "reconnecting");
    expect(reconnecting.connection).toBe("reconnecting");
    expect(reconnecting.stage).toEqual(open.stage);
  });
});

describe("the OpenStar volume", () => {
  it("is unknown until the server says, then follows it", () => {
    expect(initialLiveState.volume).toBeNull();
    const told = receive(synced(false), {
      type: "volume",
      volume: 80,
      stepped: false,
    });
    expect(told.volume).toBe(80);
    expect(told.volumeSteps).toBe(0);
  });

  it("counts every step, one that changes nothing included", () => {
    let state = receive(synced(true), {
      type: "volume",
      volume: 100,
      stepped: false,
    });
    state = receive(state, { type: "volume", volume: 100, stepped: true });
    state = receive(state, { type: "volume", volume: 95, stepped: true });
    expect(state.volume).toBe(95);
    expect(state.volumeSteps).toBe(2);
  });

  it("is kept when the server tells the live state again", () => {
    const told = receive(synced(true), {
      type: "volume",
      volume: 65,
      stepped: true,
    });
    const again = receive(told, {
      type: "liveState",
      stageId: "main",
      party,
      isStage: true,
    });
    expect(again.volume).toBe(65);
  });
});

describe("Song progress on a Remote", () => {
  const playing = (requestId: number, paused = false): PartySnapshot => ({
    ...party,
    playing: { requestId, songId: 7, paused },
  });
  const progress = (
    requestId: number,
    positionSeconds: number,
    rate: number,
    ageMs = 0,
  ): ServerMessage => ({
    type: "songProgress",
    progress: { requestId, positionSeconds, rate, lengthSeconds: 200, ageMs },
  });
  const changed = (next: PartySnapshot): ServerMessage => ({
    type: "partyChanged",
    party: next,
    change: {
      actor: { kind: "stage" },
      event: {
        code: "songPaused",
        params: { requestId: 1, songId: 7, title: "Solo" },
      },
    },
  });

  it("has no progress until the Stage reports", () => {
    expect(initialLiveState.songProgress).toBeNull();
    expect(synced(false, playing(1)).songProgress).toBeNull();
  });

  it("keeps the latest report, pinned to when it was heard", () => {
    let state = synced(false, playing(1));
    state = receive(state, progress(1, 0, 1), 1_000);
    state = receive(state, changed(playing(1, true)), 6_000);
    state = receive(state, progress(1, 5, 0), 6_050);
    expect(state.songProgress).toEqual({
      requestId: 1,
      positionSeconds: 5,
      rate: 0,
      lengthSeconds: 200,
      atMs: 6_050,
    });
    state = receive(state, progress(1, 5, 1), 9_100);
    state = receive(state, progress(1, 0, 1), 20_000);
    expect(state.songProgress).toMatchObject({
      positionSeconds: 0,
      rate: 1,
      atMs: 20_000,
    });
  });

  it("pins a report heard on connecting mid-Song to when it was sent", () => {
    let state = synced(false, playing(1));
    state = receive(state, progress(1, 40, 1, 2_500), 10_000);
    expect(state.songProgress?.atMs).toBe(7_500);
  });

  it("drops the progress once its Song stops playing, and ignores stale reports", () => {
    let state = synced(false, playing(1));
    state = receive(state, progress(1, 3, 1), 1_000);
    state = receive(state, changed(playing(2)), 2_000);
    expect(state.songProgress).toBeNull();
    state = receive(state, progress(1, 9, 1), 2_100);
    expect(state.songProgress).toBeNull();
    state = receive(state, progress(2, 0, 1), 2_200);
    expect(state.songProgress?.requestId).toBe(2);
    state = receive(state, changed(party), 3_000);
    expect(state.songProgress).toBeNull();
  });

  it("forgets the progress when the live state comes again (a reconnect)", () => {
    let state = synced(false, playing(1));
    state = receive(state, progress(1, 3, 1), 1_000);
    state = receive(state, {
      type: "liveState",
      stageId: "main",
      party: playing(1),
      isStage: false,
    });
    expect(state.songProgress).toBeNull();
  });
});
