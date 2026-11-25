import { describe, expect, it } from "vitest";

import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { Request } from "../../generated/Request";
import { partyOf } from "../people/testPhone";
import { headState, requestActions } from "./queueActions";

const request = (requestId: number): Request => ({
  requestId,
  kind: "song",
  songId: requestId * 10,
  requestedPlayers: [],
  adder: null,
});

/** A Party whose Queue holds Requests 1..n, the first as its head. */
function queueOf(n: number, more: Partial<PartySnapshot> = {}): PartySnapshot {
  const queue = Array.from({ length: n }, (_, i) => request(i + 1));
  return { ...partyOf([]), queue, head: 1, ...more };
}

const playing = (party: PartySnapshot): PartySnapshot => ({
  ...party,
  playing: { requestId: 1, songId: 10, paused: false },
});

describe("which actions a Request card offers", () => {
  it("offers the head only Change singers and Remove while its Line-up waits", () => {
    expect(requestActions(queueOf(4), 1)).toEqual({
      playNext: false,
      moveUp: false,
      moveDown: false,
      changeSingers: true,
      remove: "hold",
    });
  });

  it("does not let the playing Request be removed: Skip or End does that", () => {
    expect(requestActions(playing(queueOf(4)), 1)).toMatchObject({
      changeSingers: true,
      remove: "playing",
    });
  });

  it("lets the second place move down but not up or next, since nothing moves above the head", () => {
    expect(requestActions(queueOf(4), 2)).toEqual({
      playNext: false,
      moveUp: false,
      moveDown: true,
      changeSingers: true,
      remove: "hold",
    });
  });

  it("offers Play next, Move up and Move down below the second place", () => {
    expect(requestActions(queueOf(4), 3)).toEqual({
      playNext: true,
      moveUp: true,
      moveDown: true,
      changeSingers: true,
      remove: "hold",
    });
  });

  it("does not move the last Request down", () => {
    expect(requestActions(queueOf(4), 4)).toEqual({
      playNext: true,
      moveUp: true,
      moveDown: false,
      changeSingers: true,
      remove: "hold",
    });
  });

  it("offers no move at all to a Request that is both second and last", () => {
    expect(requestActions(queueOf(2), 2)).toMatchObject({
      playNext: false,
      moveUp: false,
      moveDown: false,
    });
  });

  it("lets the first Request move while the results show and there is no head", () => {
    const results = queueOf(3, {
      head: null,
      results: { requestId: 9, songId: 90, ended: "played" },
    });
    expect(requestActions(results, 1)).toMatchObject({
      playNext: false,
      moveUp: false,
      moveDown: true,
    });
    expect(requestActions(results, 2)).toMatchObject({
      playNext: true,
      moveUp: true,
      moveDown: true,
    });
  });

  it("offers nothing for a Request that is not in the Queue any more", () => {
    expect(requestActions(queueOf(3), 42)).toBeNull();
  });
});

describe("the head's highlight", () => {
  it("is up next while its Line-up waits and playing now while its Song plays", () => {
    expect(headState(queueOf(2), 1)).toBe("upNext");
    expect(headState(playing(queueOf(2)), 1)).toBe("playing");
  });

  it("is on no other Request, nor on any while the results show", () => {
    expect(headState(queueOf(2), 2)).toBeNull();
    expect(headState(queueOf(2, { head: null }), 1)).toBeNull();
  });
});
