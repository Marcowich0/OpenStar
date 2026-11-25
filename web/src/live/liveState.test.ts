import { describe, expect, it } from "vitest";

import type { ServerMessage } from "../generated/ServerMessage";
import { connectionChanged, initialLiveState, receive } from "./liveState";

describe("live state reducer", () => {
  it("takes the whole Stage state from the live-state message", () => {
    const state = receive(initialLiveState, {
      type: "liveState",
      stageId: "main",
      placeholder: "Hello",
    });
    expect(state.stage).toEqual({ stageId: "main", placeholder: "Hello" });
  });

  it("applies a placeholder change to the Stage it names", () => {
    const synced = receive(initialLiveState, {
      type: "liveState",
      stageId: "main",
      placeholder: "Hello",
    });
    const changed = receive(synced, {
      type: "placeholderChanged",
      stageId: "main",
      placeholder: "Bye",
    });
    expect(changed.stage).toEqual({ stageId: "main", placeholder: "Bye" });
  });

  it("ignores a change for another Stage", () => {
    const synced = receive(initialLiveState, {
      type: "liveState",
      stageId: "main",
      placeholder: "Hello",
    });
    expect(
      receive(synced, {
        type: "placeholderChanged",
        stageId: "other",
        placeholder: "Bye",
      }),
    ).toEqual(synced);
  });

  it("keeps the last rejection as a code with its parameters", () => {
    const state = receive(initialLiveState, {
      type: "rejected",
      reason: { code: "placeholderTooLong", params: { maxLength: 1000 } },
    });
    expect(state.lastRejection).toEqual({
      code: "placeholderTooLong",
      params: { maxLength: 1000 },
    });
  });

  it("records the nonce of the last pong", () => {
    expect(receive(initialLiveState, { type: "pong", nonce: 7 }).lastPong).toBe(
      7,
    );
  });

  it("leaves the state alone on a change notice", () => {
    expect(
      receive(initialLiveState, { type: "changed", topics: ["placeholder"] }),
    ).toBe(initialLiveState);
  });

  it("keeps the last known Stage state while reconnecting", () => {
    const synced = receive(connectionChanged(initialLiveState, "open"), {
      type: "liveState",
      stageId: "main",
      placeholder: "Hello",
    });
    const reconnecting = connectionChanged(synced, "reconnecting");
    expect(reconnecting.connection).toBe("reconnecting");
    expect(reconnecting.stage).toEqual(synced.stage);
  });

  it("folds a sequence of messages into one state", () => {
    const messages: ServerMessage[] = [
      { type: "liveState", stageId: "main", placeholder: "Hello" },
      { type: "placeholderChanged", stageId: "other", placeholder: "Nope" },
      {
        type: "rejected",
        reason: { code: "placeholderTooLong", params: { maxLength: 1000 } },
      },
      { type: "placeholderChanged", stageId: "main", placeholder: "Bye" },
      { type: "changed", topics: ["placeholder"] },
      { type: "pong", nonce: 3 },
    ];
    expect(messages.reduce(receive, initialLiveState)).toEqual({
      connection: "connecting",
      stage: { stageId: "main", placeholder: "Bye" },
      lastRejection: {
        code: "placeholderTooLong",
        params: { maxLength: 1000 },
      },
      lastPong: 3,
    });
  });

  it("keeps the state it was given (a pure function)", () => {
    const synced = receive(initialLiveState, {
      type: "liveState",
      stageId: "main",
      placeholder: "Hello",
    });
    const copy = structuredClone(synced);
    receive(synced, {
      type: "placeholderChanged",
      stageId: "main",
      placeholder: "Bye",
    });
    expect(synced).toEqual(copy);
  });

  it("keeps an untouched slice by reference, so selectors skip re-renders", () => {
    const synced = receive(initialLiveState, {
      type: "liveState",
      stageId: "main",
      placeholder: "Hello",
    });
    expect(receive(synced, { type: "pong", nonce: 1 }).stage).toBe(
      synced.stage,
    );
  });
});
