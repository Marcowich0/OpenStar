import { describe, expect, it } from "vitest";

import type { Actor } from "../generated/Actor";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { LiveStateMessage } from "./liveState";
import { initialLiveState, receive, type LiveState } from "./liveState";
import { addStageToast, dismissToast, MAX_TOASTS } from "./toasts";

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
  localMics: [],
};

/** A browser that has the live state: the Stage, or a Phone. */
const browser = (isStage: boolean): LiveState =>
  receive(initialLiveState, {
    type: "liveState",
    stageId: "main",
    party,
    isStage,
  });

const stage = browser(true);
const phone = browser(false);

const remote: Actor = { kind: "member", memberId: 3 };

const change = (actor: Actor, joinCode = "9133"): LiveStateMessage => ({
  type: "partyChanged",
  party: { ...party, partyId: `p-${joinCode}`, joinCode },
  change: { actor, event: { code: "partyStarted", params: { joinCode } } },
});

describe("Party changes as toast entries", () => {
  it("replaces the Party state with each snapshot", () => {
    const next = receive(phone, change({ kind: "stage" }, "5555"));
    expect(next.stage?.party).toEqual({
      partyId: "p-5555",
      stageId: "main",
      joinCode: "5555",
      startedAtMs: 1000,
      members: [],
      phones: [],
      queue: [],
      head: null,
      lineUp: null,
      playing: null,
      results: null,
      localMics: [],
    });
  });

  it("gives no toast anywhere when only the Local mics changed", () => {
    const localMics: LiveStateMessage = {
      type: "partyChanged",
      party,
      change: { actor: { kind: "stage" }, event: { code: "localMicsChanged" } },
    };
    expect(receive(phone, localMics).toasts).toEqual([]);
    expect(receive(stage, localMics).toasts).toEqual([]);
  });

  it("gives no toast anywhere when only the calibrations changed", () => {
    const calibration: LiveStateMessage = {
      type: "partyChanged",
      party,
      change: {
        actor: { kind: "stage" },
        event: { code: "calibrationChanged" },
      },
    };
    expect(receive(phone, calibration).toasts).toEqual([]);
    expect(receive(stage, calibration).toasts).toEqual([]);
  });

  it("gives no toast on the Stage for a change made on the Stage", () => {
    expect(receive(stage, change({ kind: "stage" })).toasts).toEqual([]);
  });

  it("gives a toast on a Phone for a change made on the Stage", () => {
    expect(receive(phone, change({ kind: "stage" })).toasts).toEqual([
      {
        id: 0,
        actor: { kind: "stage" },
        event: { code: "partyStarted", params: { joinCode: "9133" } },
      },
    ]);
  });

  it("gives a toast on the Stage and on a Phone for a change from a Remote", () => {
    const entry = {
      id: 0,
      actor: { kind: "member", memberId: 3 },
      event: { code: "partyStarted", params: { joinCode: "9133" } },
    };
    expect(receive(stage, change(remote)).toasts).toEqual([entry]);
    expect(receive(phone, change(remote)).toasts).toEqual([entry]);
  });

  it("gives a toast on the Stage and on a Phone for a deletion from the Admin area", () => {
    const entry = {
      id: 0,
      actor: { kind: "admin" },
      event: { code: "partyStarted", params: { joinCode: "9133" } },
    };
    expect(receive(stage, change({ kind: "admin" })).toasts).toEqual([entry]);
    expect(receive(phone, change({ kind: "admin" })).toasts).toEqual([entry]);
  });

  it("keeps a former Stage's toasts like a Phone's once the Stage moved", () => {
    const moved = receive(stage, { type: "stageMoved" });
    expect(receive(moved, change({ kind: "stage" })).toasts).toHaveLength(1);
  });

  it("keeps the newest toasts, oldest first, at most three", () => {
    let state = phone;
    for (const code of ["1111", "2222", "3333", "4444"]) {
      state = receive(state, change(remote, code));
    }
    expect(MAX_TOASTS).toBe(3);
    expect(
      state.toasts.map((toast) => [
        toast.id,
        toast.event.code === "partyStarted"
          ? toast.event.params.joinCode
          : null,
      ]),
    ).toEqual([
      [1, "2222"],
      [2, "3333"],
      [3, "4444"],
    ]);
  });

  it("drops a toast when it is dismissed, and nothing else", () => {
    const one = receive(phone, change(remote, "1111"));
    const two = receive(one, change(remote, "2222"));
    const dismissed = dismissToast(two, 0);
    expect(dismissed.toasts.map((toast) => toast.id)).toEqual([1]);
    expect(dismissed.stage).toBe(two.stage);
    expect(dismissToast(dismissed, 0)).toBe(dismissed);
  });

  it("keeps the toasts by reference when a message changes no toast", () => {
    const state = receive(phone, change(remote));
    const ponged = receive(state, { type: "pong", nonce: 1 });
    expect(ponged.toasts).toBe(state.toasts);
    const quiet = receive(stage, change({ kind: "stage" }));
    expect(quiet.toasts).toBe(stage.toasts);
  });
});

describe("toasts the Stage raises itself", () => {
  const back = (memberId: number) =>
    ({
      code: "backOnMic",
      params: { memberId, name: "Mia" },
    }) as const;

  it("are toasts about that Party member, after the Party changes, at most three", () => {
    let state = receive(stage, change(remote, "1111"));
    state = { ...state, ...addStageToast(state, back(2)) };
    expect(state.toasts.map((toast) => [toast.id, toast.actor])).toEqual([
      [0, remote],
      [1, { kind: "member", memberId: 2 }],
    ]);
    expect(state.toasts[1]?.event).toEqual(back(2));
    for (let i = 0; i < MAX_TOASTS; i++) {
      state = { ...state, ...addStageToast(state, back(i)) };
    }
    expect(state.toasts.map((toast) => toast.id)).toEqual([2, 3, 4]);
  });
});
