import { describe, expect, it } from "vitest";

import { initialRoundTrip, ping, receive } from "./roundTrip";

describe("WebSocket round trip", () => {
  it("is complete once the pong carries the nonce that was sent", () => {
    const { state, message } = ping(initialRoundTrip, 7);
    expect(message).toEqual({ type: "ping", nonce: 7 });
    expect(state).toEqual({ status: "waiting", nonce: 7 });

    expect(receive(state, { type: "pong", nonce: 7 })).toEqual({
      status: "complete",
      nonce: 7,
    });
  });

  it("keeps waiting when a pong answers a different ping", () => {
    const { state } = ping(initialRoundTrip, 7);
    expect(receive(state, { type: "pong", nonce: 8 })).toEqual({
      status: "waiting",
      nonce: 7,
    });
  });

  it("ignores a pong before anything was sent", () => {
    expect(receive(initialRoundTrip, { type: "pong", nonce: 1 })).toEqual(
      initialRoundTrip,
    );
  });

  it("fails when the server rejects what was sent", () => {
    const { state } = ping(initialRoundTrip, 7);
    expect(
      receive(state, { type: "rejected", code: "invalidMessage" }),
    ).toEqual({ status: "rejected", code: "invalidMessage" });
  });
});
