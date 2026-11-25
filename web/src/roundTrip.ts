import type { ClientMessage } from "./generated/ClientMessage";
import type { RejectCode } from "./generated/RejectCode";
import type { ServerMessage } from "./generated/ServerMessage";

/** Where the walking skeleton's one WebSocket round trip stands. */
export type RoundTrip =
  | { status: "idle" }
  | { status: "waiting"; nonce: number }
  | { status: "complete"; nonce: number }
  | { status: "rejected"; code: RejectCode };

export const initialRoundTrip: RoundTrip = { status: "idle" };

/** Starts a round trip: the new state and the message to send. */
export function ping(
  _state: RoundTrip,
  nonce: number,
): { state: RoundTrip; message: ClientMessage } {
  return {
    state: { status: "waiting", nonce },
    message: { type: "ping", nonce },
  };
}

/** Applies a server message. The `switch` is exhaustive over the generated union. */
export function receive(state: RoundTrip, message: ServerMessage): RoundTrip {
  switch (message.type) {
    case "pong":
      return state.status === "waiting" && state.nonce === message.nonce
        ? { status: "complete", nonce: message.nonce }
        : state;
    case "rejected":
      return { status: "rejected", code: message.code };
    default:
      return unreachable(message);
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled server message: ${JSON.stringify(value)}`);
}
