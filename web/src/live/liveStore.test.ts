import { describe, expect, it, vi } from "vitest";

import type { ChangeTopic } from "../generated/ChangeTopic";
import type { ClientMessage } from "../generated/ClientMessage";
import type { ServerMessage } from "../generated/ServerMessage";
import type { LiveClientOptions } from "./liveClient";
import { initialLiveState, receive } from "./liveState";
import { createLiveStore } from "./liveStore";

function start(hello?: () => ClientMessage) {
  let handlers: Pick<LiveClientOptions, "onMessage" | "onConnection"> | null =
    null;
  const sent: ClientMessage[] = [];
  const store = createLiveStore((given) => {
    handlers = given;
    return {
      send: (message) => {
        sent.push(message);
        return true;
      },
      close: () => {},
    };
  }, hello);
  const server = (message: ServerMessage) => {
    handlers?.onMessage(message);
  };
  const connection = (state: "open" | "reconnecting") => {
    handlers?.onConnection(state);
  };
  return { store, server, connection, sent };
}

describe("live store", () => {
  it("applies server messages and tells subscribers", () => {
    const { store, server, connection } = start();
    const listener = vi.fn();
    store.subscribe(listener);

    connection("open");
    server({ type: "liveState", stageId: "main", party: null, isStage: true });

    expect(store.getSnapshot().connection).toBe("open");
    expect(store.getSnapshot().stage?.isStage).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the same snapshot when nothing changed", () => {
    const { store, server } = start();
    const before = store.getSnapshot();
    server({ type: "changed", topics: [] });
    expect(store.getSnapshot()).toBe(before);
  });

  it("tells the listeners of each topic a change notice names", () => {
    const { store, server } = start();
    const library: ChangeTopic = "library";
    const listener = vi.fn();
    const unsubscribe = store.onChanged(library, listener);

    server({ type: "changed", topics: [library] });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    server({ type: "changed", topics: [library] });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hands each Song control the Stage must act on to its listeners", () => {
    const { store, server } = start();
    const listener = vi.fn();
    const unsubscribe = store.onSongControl(listener);
    const control: ServerMessage = {
      type: "controlSong",
      requestId: 5,
      songId: 7,
      control: "pause",
    };

    server(control);
    expect(listener).toHaveBeenCalledWith(control);

    unsubscribe();
    server(control);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hands every job update to its listeners", () => {
    const { store, server } = start();
    const listener = vi.fn();
    const unsubscribe = store.onJobChanged(listener);
    const job = {
      id: 7,
      kind: "pitchTrack",
      state: { type: "running", percent: 40 },
    } as const;

    server({ type: "jobChanged", job });
    expect(listener).toHaveBeenCalledWith(job);

    unsubscribe();
    server({ type: "jobChanged", job });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("presents the Phone id each time the socket opens", () => {
    const hello: ClientMessage = { type: "hello", phoneId: "phone-1" };
    const { connection, sent } = start(() => hello);
    expect(sent).toEqual([]);
    connection("open");
    expect(sent).toEqual([hello]);
    connection("reconnecting");
    connection("open");
    expect(sent).toEqual([hello, hello]);
  });

  it("shows a toast the Stage raises itself, and tells subscribers", () => {
    const { store } = start();
    const listener = vi.fn();
    store.subscribe(listener);
    store.showStageToast({
      code: "backOnMic",
      params: { memberId: 4, name: "Mia" },
    });
    expect(store.getSnapshot().toasts).toEqual([
      {
        id: 0,
        actor: { kind: "member", memberId: 4 },
        event: { code: "backOnMic", params: { memberId: 4, name: "Mia" } },
      },
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("pins a Song progress report to the time it arrived", () => {
    const { store, server } = start();
    server({
      type: "liveState",
      stageId: "main",
      party: {
        partyId: "p1",
        stageId: "main",
        joinCode: "0427",
        startedAtMs: 0,
        members: [],
        phones: [],
        queue: [],
        head: null,
        lineUp: null,
        playing: { requestId: 1, songId: 7, paused: false },
        results: null,
        localMics: [],
      },
      isStage: false,
    });
    const now = vi.spyOn(performance, "now").mockReturnValue(5_000);
    server({
      type: "songProgress",
      progress: {
        requestId: 1,
        positionSeconds: 12,
        rate: 1,
        lengthSeconds: 90,
        ageMs: 1_000,
      },
    });
    now.mockRestore();
    expect(store.getSnapshot().songProgress).toEqual({
      requestId: 1,
      positionSeconds: 12,
      rate: 1,
      lengthSeconds: 90,
      atMs: 4_000,
    });
  });

  it("sends through the client", () => {
    const { store, sent } = start();
    store.send({ type: "newParty" });
    expect(sent).toEqual([{ type: "newParty" }]);
  });

  it("hands every server message to the reducer", () => {
    const { store, server } = start();
    const messages: ServerMessage[] = [
      { type: "liveState", stageId: "main", party: null, isStage: true },
      { type: "rejected", reason: { code: "notTheStage" } },
      {
        type: "partyChanged",
        party: {
          partyId: "p1",
          stageId: "main",
          joinCode: "0427",
          startedAtMs: 1,
          members: [],
          phones: [],
          queue: [],
          head: null,
          lineUp: null,
          playing: null,
          results: null,
          localMics: [],
        },
        change: {
          actor: { kind: "stage" },
          event: { code: "partyStarted", params: { joinCode: "0427" } },
        },
      },
      { type: "stageMoved" },
      { type: "changed", topics: [] },
      { type: "pong", nonce: 9 },
    ];
    for (const message of messages) server(message);
    expect(store.getSnapshot()).toEqual(
      messages.reduce(receive, initialLiveState),
    );
  });
});
