// A stand-in for the live store's Song playing now, for component tests
// (#225): `play(song)` starts Song `song` on the Stage, `play(null)` stops
// it, as the server's `liveState` would tell it.

import { act } from "@testing-library/react";

import type { PartySnapshot } from "../generated/PartySnapshot";
import type { SongId } from "../generated/SongId";
import { initialLiveState, receive, type LiveState } from "./liveState";

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

function stateWith(song: SongId | null): LiveState {
  return receive(initialLiveState, {
    type: "liveState",
    stageId: "main",
    isStage: false,
    party: {
      ...party,
      playing:
        song === null ? null : { requestId: 1, songId: song, paused: false },
    },
  });
}

export function playingFeed(song: SongId | null = null) {
  let state = stateWith(song);
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    play(next: SongId | null) {
      act(() => {
        state = stateWith(next);
        for (const l of [...listeners]) l();
      });
    },
  };
}
