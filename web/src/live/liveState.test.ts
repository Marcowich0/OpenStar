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
