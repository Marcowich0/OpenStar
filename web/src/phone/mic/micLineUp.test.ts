import { describe, expect, it, vi } from "vitest";

import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { PlayerResult } from "../../generated/PlayerResult";
import { initialLiveState, type LiveState } from "../../live/liveState";
import {
  BO_SEAT,
  JONAS_SEAT,
  LINE_UP,
  MY_PHONE,
  PARTY,
} from "../stage/testParty";
import { followLineUp, micRole } from "./micLineUp";
import type { PhoneMicState } from "./phoneMic";

const live = (party: PartySnapshot | null): LiveState => ({
  ...initialLiveState,
  stage: { stageId: "main", party, isStage: false, stageMoved: false },
});

const boResult = { mic: BO_SEAT.mic } as PlayerResult;

/** The Song ended: its results show, and no Line-up waits yet. */
const RESULTS: PartySnapshot = {
  ...PARTY,
  head: null,
  lineUp: null,
  results: {
    requestId: 1,
    songId: 40,
    ended: "finished",
    players: [boResult],
  } as PartySnapshot["results"],
};

const SONG_BROWSER: PartySnapshot = { ...PARTY, head: null, lineUp: null };

describe("micRole", () => {
  it("is seated while a seat of the Line-up names this Phone", () => {
    expect(micRole(live(PARTY), MY_PHONE)).toBe("seated");
  });

  it("is between Line-ups while the results of a Song this Phone sang show", () => {
    expect(micRole(live(RESULTS), MY_PHONE)).toBe("between");
  });

  it("has left when the Line-up seats it no longer, or no Line-up comes", () => {
    const without = { ...PARTY, lineUp: { ...LINE_UP, seats: [JONAS_SEAT] } };
    expect(micRole(live(without), MY_PHONE)).toBe("left");
    expect(micRole(live(SONG_BROWSER), MY_PHONE)).toBe("left");
    expect(
      micRole(
        live({ ...RESULTS, results: { ...RESULTS.results!, players: [] } }),
        MY_PHONE,
      ),
    ).toBe("left");
  });

  it("holds while the state is not known (before the server told it)", () => {
    expect(micRole(initialLiveState, MY_PHONE)).toBe("between");
  });
});

function fakeStore(state: LiveState) {
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: LiveState) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function fakeMic(state: PhoneMicState = "on") {
  const mic = {
    state,
    getSnapshot: () => ({ state: mic.state }),
    turnOff: vi.fn(() => {
      mic.state = "off";
    }),
  };
  return mic;
}

describe("followLineUp", () => {
  it("keeps one open mic across two consecutive Line-ups", () => {
    const store = fakeStore(live(PARTY));
    const mic = fakeMic();
    followLineUp(store, MY_PHONE, mic);
    // The Song plays out, its results show, the next Line-up seats Bo again.
    store.set(live({ ...PARTY, playing: {} as PartySnapshot["playing"] }));
    store.set(live(RESULTS));
    store.set(
      live({ ...PARTY, head: 2, lineUp: { ...LINE_UP, requestId: 2 } }),
    );
    expect(mic.turnOff).not.toHaveBeenCalled();
  });

  it("releases the mic when the Phone leaves the Line-up", () => {
    const store = fakeStore(live(PARTY));
    const mic = fakeMic();
    followLineUp(store, MY_PHONE, mic);
    store.set(live({ ...PARTY, lineUp: { ...LINE_UP, seats: [JONAS_SEAT] } }));
    expect(mic.turnOff).toHaveBeenCalledTimes(1);
  });

  it("releases it when no next Line-up seats it after the results", () => {
    const store = fakeStore(live(RESULTS));
    const mic = fakeMic();
    followLineUp(store, MY_PHONE, mic);
    store.set(live(SONG_BROWSER));
    expect(mic.turnOff).toHaveBeenCalledTimes(1);
  });

  it("releases a lost mic too, and leaves an off mic alone", () => {
    const store = fakeStore(live(PARTY));
    const lost = fakeMic("lost");
    const off = fakeMic("off");
    followLineUp(store, MY_PHONE, lost);
    followLineUp(store, MY_PHONE, off);
    store.set(live(SONG_BROWSER));
    expect(lost.turnOff).toHaveBeenCalledTimes(1);
    expect(off.turnOff).not.toHaveBeenCalled();
  });

  it("stops following on unsubscribe", () => {
    const store = fakeStore(live(PARTY));
    const mic = fakeMic();
    const stop = followLineUp(store, MY_PHONE, mic);
    stop();
    store.set(live(SONG_BROWSER));
    expect(mic.turnOff).not.toHaveBeenCalled();
  });
});
