import type { CalibrationRun } from "../generated/CalibrationRun";
import type { JoinCode } from "../generated/JoinCode";
import type { PartyMemberId } from "../generated/PartyMemberId";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { PhoneId } from "../generated/PhoneId";
import type { RequestId } from "../generated/RequestId";
import type { ServerMessage } from "../generated/ServerMessage";
import type { StageId } from "../generated/StageId";
import type { UserMessage } from "../generated/UserMessage";
import { anchorProgress, type ProgressAnchor } from "./songProgress";
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

/** Where this browser's Phone stands in the Party, as the server told it. */
export interface PhoneState {
  /** The Party member this Phone uses, or `null` when it is not in the Party. */
  memberId: PartyMemberId | null;
  /** It was in the Party and no longer is (a new Party started). */
  leftParty: boolean;
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
  /** `null` until the server answered this connection's Phone id. */
  phone: PhoneState | null;
  /** The Join code the server last confirmed is the current Party's. */
  validJoinCode: JoinCode | null;
  /**
   * The Stage's current OpenStar volume (0 to 100), or `null` until the
   * server has told it (no Stage has reported its output yet). The effective
   * Mic threshold (`resolveMicSettings` in `mics/micSettings.ts`) takes it:
   * read it once at Start for the scorer, and on every frame for a meter's
   * threshold line.
   */
  volume: number | null;
  /** How many volume steps (from the Stage or a Remote) the server has told. */
  volumeSteps: number;
  /**
   * The Stage's latest position report for the playing Song (#159), pinned
   * to this browser's clock; `null` while no Song plays or before the Stage
   * has reported. `progressAt` (`songProgress.ts`) extrapolates from it.
   */
  songProgress: ProgressAnchor | null;
  /**
   * Phone only: the running total of the seat this Phone is the Mic of, as
   * the Stage's scorer last reported it at a Line end (#167), with the
   * Request it was sung in; `null` before the first report.
   */
  lineScore: LineScore | null;
  /**
   * Check A/V sync runs on the Stage (#163), as the server told it: the
   * Stage shows the test pattern, a Remote its big −/+ and Done.
   */
  avSync: boolean;
  /**
   * What the server told about the running Check A/V sync (#168): the Phone
   * that started it (`null` for the Stage, or before it is told), whose page
   * shows the −/+ and Done, and the Stage's A/V offset once reported.
   */
  avSyncCheck: AvSyncCheck;
  /**
   * The open Calibrate mics run (#170), as the server told it, or `null`:
   * its checklist, each chosen Mic waiting or ready, the tones, the results.
   */
  calibration: CalibrationRun | null;
}

/** What is known about the running Check A/V sync. */
export interface AvSyncCheck {
  startedBy: PhoneId | null;
  avOffsetMs: number | null;
}

const NO_AV_SYNC_CHECK: AvSyncCheck = { startedBy: null, avOffsetMs: null };

/** A seat's running total at its last Line end, in Request `requestId`. */
export interface LineScore {
  requestId: RequestId;
  total: number;
}

export const initialLiveState: LiveState = {
  connection: "connecting",
  stage: null,
  toasts: [],
  nextToastId: 0,
  lastRejection: null,
  lastPong: null,
  phone: null,
  validJoinCode: null,
  volume: null,
  volumeSteps: 0,
  songProgress: null,
  lineScore: null,
  avSync: false,
  avSyncCheck: NO_AV_SYNC_CHECK,
  calibration: null,
};

/** The progress, kept only while its Request is the one playing in `party`. */
function progressFor(
  progress: ProgressAnchor | null,
  party: PartySnapshot | null,
): ProgressAnchor | null {
  return progress !== null && party?.playing?.requestId === progress.requestId
    ? progress
    : null;
}

/**
 * Applies a server message. The `switch` is exhaustive over the generated union.
 * `receivedAtMs` is this browser's clock when the message arrived; only a
 * Song progress report uses it.
 */
export function receive(
  state: LiveState,
  message: ServerMessage,
  receivedAtMs = 0,
): LiveState {
  switch (message.type) {
    case "liveState":
      return {
        ...state,
        // The server tells the latest report again right after this, and
        // whether Check A/V sync runs and the open Calibration run.
        songProgress: null,
        avSync: false,
        avSyncCheck: NO_AV_SYNC_CHECK,
        calibration: null,
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
            songProgress: progressFor(state.songProgress, message.party),
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
    case "phoneStatus":
      return {
        ...state,
        phone: { memberId: message.memberId, leftParty: false },
      };
    case "leftParty":
      return {
        ...state,
        phone: { memberId: null, leftParty: true },
        validJoinCode: null,
      };
    case "joinCodeValid":
      return { ...state, validJoinCode: message.joinCode };
    case "volume":
      return {
        ...state,
        volume: message.volume,
        volumeSteps: state.volumeSteps + (message.stepped ? 1 : 0),
      };
    case "songProgress": {
      const anchor = progressFor(
        anchorProgress(message.progress, receivedAtMs),
        state.stage?.party ?? null,
      );
      return anchor === null ? state : { ...state, songProgress: anchor };
    }
    case "lineScore":
      return {
        ...state,
        lineScore: { requestId: message.requestId, total: message.total },
      };
    case "avSync":
      return state.avSync === message.running
        ? state
        : { ...state, avSync: message.running, avSyncCheck: NO_AV_SYNC_CHECK };
    case "avSyncCheck":
      return {
        ...state,
        avSyncCheck: {
          startedBy: message.startedBy,
          avOffsetMs: message.avOffsetMs,
        },
      };
    case "calibration":
      return { ...state, calibration: message.run };
    case "stepAvSync":
      // Stage only: routed to the Check A/V sync screen in liveStore.ts.
      return state;
    case "changed":
      // Change notices invalidate HTTP data; they change no live state.
      return state;
    case "pitchReading":
    case "clockPing":
    case "clockPong":
    case "micClosed":
    case "micPage":
    case "localMicLevels":
      // The Pitch reading relay, clock sync and bridge levels change no live state; they
      // are routed away from the reducer in liveStore.ts (#127).
      return state;
    case "controlSong":
      // Stage only: the Stage's playback acts on it (#164); the Party's
      // 'playing' state comes with the `partyChanged` before it.
      return state;
    case "bridgeUpdate":
    case "bridgeWaiting":
    case "bridgeApproved":
    case "bridgeConnected":
    case "bridgeChannels":
    case "bridgeMicsScreen":
    case "bridgeDetecting":
      // Only a Mic bridge's own socket gets these.
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
