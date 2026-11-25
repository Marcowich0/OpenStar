import type { PartySnapshot } from "../generated/PartySnapshot";
import type { ServerMessage } from "../generated/ServerMessage";
import type { StageId } from "../generated/StageId";
import type { UserMessage } from "../generated/UserMessage";
import { addToast, type Toast } from "./toasts";

/** Where the browser's one WebSocket stands. */
export type LiveConnection = "connecting" | "open" | "reconnecting";

/** The live state of the browser's Stage. */
export interface StageState {
  stageId: StageId;
  /** `null` before the first Stage has opened on a fresh server. */
  party: PartySnapshot | null;
  /** Whether this browser is the active Stage. */
  isStage: boolean;
  /** Another browser became the Stage while this one was it. */
  stageMoved: boolean;
}

/** The browser's copy of the live state the server owns. */
export interface LiveState {
  connection: LiveConnection;
  /** `null` until the server has told this browser the state. */
  stage: StageState | null;
  /** Party changes to show as toasts, oldest first (`toasts.ts`). */
  toasts: readonly Toast[];
  /** The id the next toast gets. */
  nextToastId: number;
  lastRejection: UserMessage | null;
  lastPong: number | null;
}

export const initialLiveState: LiveState = {
  connection: "connecting",
  stage: null,
  toasts: [],
  nextToastId: 0,
  lastRejection: null,
  lastPong: null,
};

/** Applies a server message. The `switch` is exhaustive over the generated union. */
export function receive(state: LiveState, message: ServerMessage): LiveState {
  switch (message.type) {
    case "liveState":
      return {
        ...state,
        stage: {
          stageId: message.stageId,
          party: message.party,
          isStage: message.isStage,
          stageMoved: false,
        },
      };
    case "partyChanged":
      return state.stage?.stageId === message.party.stageId
        ? {
            ...state,
            stage: { ...state.stage, party: message.party },
            ...addToast(state, state.stage.isStage, message.change),
          }
        : state;
    case "stageMoved":
      return state.stage
        ? {
            ...state,
            stage: { ...state.stage, isStage: false, stageMoved: true },
          }
        : state;
    case "rejected":
      return { ...state, lastRejection: message.reason };
    case "pong":
      return { ...state, lastPong: message.nonce };
    case "changed":
      // Change notices invalidate HTTP data; they change no live state.
      return state;
    case "jobChanged":
      // Job updates belong to the screens that show jobs (Downloads, the
      // Timing editor); the live state does not keep them.
      return state;
    default:
      return unreachable(message);
  }
}

/** The WebSocket opened, closed or is being opened again. */
export function connectionChanged(
  state: LiveState,
  connection: LiveConnection,
): LiveState {
  return state.connection === connection ? state : { ...state, connection };
}

function unreachable(value: never): never {
  throw new Error(`unhandled server message: ${JSON.stringify(value)}`);
}
