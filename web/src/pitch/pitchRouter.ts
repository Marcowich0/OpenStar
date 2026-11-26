/**
 * Routes the Stage's Pitch readings into per-Player ring buffers, outside the
 * reducer and React. The live store hands every `pitchReading` message here;
 * the sing screen starts a session at Start, with the Mic-to-Player map from
 * the Line-up, and the scorer and the pitch line read the buffers it returns.
 */

import { placedSongTime, type PlacementClock } from "../clock/placement";
import type { MicId } from "../generated/MicId";
import type { PitchReading } from "../generated/PitchReading";
import type { MicEvent } from "../scoring/micLost";
import { PitchBuffer } from "./pitchBuffer";

/**
 * What a Mic's connection or page reports, besides its readings: the lost-Mic
 * rule's other signals (`scoring/micLost.ts`).
 */
export type MicSignal = Exclude<MicEvent["kind"], "reading">;

/**
 * Places a reading from Player `player`'s Mic on Song time, or `null` to drop
 * it (see `clock/placement.ts`). The Player index lets it pick that Mic's
 * Mic delay.
 */
export type Placement = (
  reading: PitchReading,
  player: number,
) => number | null;

export interface PitchSession {
  /** How many Players sing: one buffer each, in Line-up order. */
  players: number;
  /** Which Player (index into the buffers) each Mic sings for. */
  mics: readonly (readonly [MicId, number])[];
  /** Readings per buffer (`pitchBufferCapacity`). */
  capacity: number;
  place: Placement;
  /**
   * Told of every reading that arrives from a Mic of this Song, before
   * placement drops any (the lost-Mic rule: a paused Song's Mic still sends).
   */
  heard?: (player: number) => void;
  /**
   * Told when a Mic of this Song closes (`micClosed`) or reports its page
   * hidden or visible, and that it is back (`connectionBack`) when a reading
   * arrives from a Mic that had closed.
   */
  signal?: (player: number, kind: MicSignal) => void;
}

export interface PitchRouter {
  /**
   * Starts a Song: allocates one empty buffer per Player and routes readings
   * into them until `stop()` or the next `start()`.
   */
  start: (session: PitchSession) => readonly PitchBuffer[];
  /** Ends the Song: readings are dropped until the next `start()`. */
  stop: () => void;
  /** The current Song's buffers; empty while no Song runs. */
  buffers: () => readonly PitchBuffer[];
  /** Takes one relayed reading; dropped unless its Mic sings in this Song. */
  receive: (mic: MicId, reading: PitchReading) => void;
  /**
   * Takes a Mic's signal: the server's `micClosed`, or a Phone reporting its
   * page hidden or visible (no wire message carries that yet). Dropped
   * unless the Mic sings in this Song.
   */
  signal: (mic: MicId, kind: MicSignal) => void;
}

/**
 * The usual `Placement`: on the Song clock, with each Player's Mic delay
 * (`micDelayMs(player)`, from that Mic's settings).
 */
export function clockPlacement(
  clock: PlacementClock,
  micDelayMs: (player: number) => number,
): Placement {
  return (reading, player) =>
    placedSongTime(clock, reading.captureMs, micDelayMs(player));
}

/**
 * A Map key for a Mic. Only Phones relay readings so far; a new `MicId` kind
 * (#151's Mic bridge) fails to compile here until it gets its own key.
 */
function micKey(mic: MicId): string {
  return `${mic.kind}:${String(mic.connection)}`;
}

const noBuffers: readonly PitchBuffer[] = [];

export function createPitchRouter(): PitchRouter {
  let buffers = noBuffers;
  let players = new Map<string, number>();
  let place: Placement = () => null;
  let heard: ((player: number) => void) | undefined;
  let signal: PitchSession["signal"];
  /** Mics of this Song whose connection closed, until their next reading. */
  let closed = new Set<string>();

  return {
    start(session) {
      const assigned = new Map<string, number>();
      for (const [mic, player] of session.mics) {
        if (
          !Number.isInteger(player) ||
          player < 0 ||
          player >= session.players
        ) {
          throw new RangeError(
            `Mic assigned to Player ${String(player)} of ${String(session.players)}`,
          );
        }
        assigned.set(micKey(mic), player);
      }
      const fresh: PitchBuffer[] = [];
      for (let i = 0; i < session.players; i++) {
        fresh.push(new PitchBuffer(session.capacity));
      }
      buffers = fresh;
      players = assigned;
      place = session.place;
      heard = session.heard;
      signal = session.signal;
      closed = new Set();
      return buffers;
    },
    stop() {
      buffers = noBuffers;
      players = new Map();
      place = () => null;
      heard = undefined;
      signal = undefined;
      closed = new Set();
    },
    buffers: () => buffers,
    receive(mic, reading) {
      const key = micKey(mic);
      const player = players.get(key);
      if (player === undefined) return;
      const buffer = buffers[player];
      if (buffer === undefined) return;
      if (closed.size > 0 && closed.delete(key)) {
        signal?.(player, "connectionBack");
      }
      heard?.(player);
      const songTime = place(reading, player);
      if (songTime !== null) buffer.push(reading, songTime);
    },
    signal(mic, kind) {
      const key = micKey(mic);
      const player = players.get(key);
      if (player === undefined) return;
      if (kind === "connectionClosed") closed.add(key);
      if (kind === "connectionBack") closed.delete(key);
      signal?.(player, kind);
    },
  };
}
