import { describe, expect, it } from "vitest";

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
});
