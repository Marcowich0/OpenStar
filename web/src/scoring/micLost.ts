/**
 * The lost-Mic rule (#54 "Lost Mics"): the one rule for when any Mic counts as
 * lost. A Mic is lost while its connection is closed (the server's `micClosed`
 * for a Phone or a Mic bridge), while its page is hidden (a Phone reports it),
 * or once no Pitch reading from it has reached the Stage for
 * `SCORING.micLostAfterMs`. A Stage-browser Local mic only ever has readings,
 * so only the last rule can apply to it.
 *
 * The rule never looks at what a reading holds (no Beat values, no loudness):
 * readings of silence keep a Mic present.
 *
 * Times are Stage time in ms, stamped when the Stage learns of the event.
 * By the silence rule a Mic is lost from `last reading + limit` until the next
 * reading arrives. That moment ends the stretch: it still counts for the
 * "lost at any moment" flag, but the Mic is present again at it. So a gap of
 * exactly the limit counts as lost; a gap just under it never does.
 */

import { SCORING } from "./constants";

/** One thing the Stage learned about a Mic, stamped with Stage time (ms). */
export type MicEvent = {
  kind:
    | "reading"
    | "connectionClosed"
    | "connectionBack"
    | "pageHidden"
    | "pageVisible";
  at: number;
};

export type MicLostQuery = {
  /**
   * Stage time (ms) the "lost at any moment" flag counts from: the Song start.
   * Before the first reading, the silence rule counts from here too.
   */
  since: number;
  /** Stage time (ms) to judge at. Events after it are ignored. */
  now: number;
};

export type MicLostState = {
  /** The Mic is lost at `now`. */
  lostNow: boolean;
  /** The Mic was lost at some moment in `[since, now]`: the Score record's mic lost flag. */
  lostSince: boolean;
};

/**
 * The lost-Mic rule fed live, one event at a time, in Stage-time order: O(1)
 * per event and per query, and no allocation, so the sing screen can feed it
 * every reading and read it every frame. `micLost` is this watch folded over a
 * list, so the two always agree.
 */
export type MicWatch = {
  /** Take the next event; throws when its time is before the previous one. */
  event(kind: MicEvent["kind"], at: number): void;
  /** Lost now, at `now`. `now` must not be before the last event taken. */
  lostAt(now: number): boolean;
  /** Lost at some moment from `since` up to `now` (also not before the last event). */
  lostSinceAt(now: number): boolean;
};

export function createMicWatch(since: number): MicWatch {
  const limit = SCORING.micLostAfterMs;
  let lastAt = -Infinity;
  let lastReading = since;
  let closed = false;
  let hidden = false;
  let lostSince = false;

  // Lost at `t` under the current signals: the signals hold until the next
  // event, and silence only grows, so checking at the end of a stretch is
  // enough to know whether any moment of it was lost.
  const lostWithSignals = (t: number) =>
    closed || hidden || t - lastReading >= limit;

  const check = (t: number) => {
    if (t < lastAt) {
      throw new Error(
        `Mic event at ${t} ms is before the last one (${lastAt} ms)`,
      );
    }
  };

  return {
    event(kind, at) {
      check(at);
      // The stretch up to this event, before the event applies.
      if (at >= since && lostWithSignals(at)) lostSince = true;
      lastAt = at;
      switch (kind) {
        case "reading":
          lastReading = at;
          break;
        case "connectionClosed":
          closed = true;
          break;
        case "connectionBack":
          closed = false;
          break;
        case "pageHidden":
          hidden = true;
          break;
        case "pageVisible":
          hidden = false;
          break;
      }
      // A signal that starts at `since` or later is a lost moment of its own.
      if (at >= since && (closed || hidden)) lostSince = true;
    },
    lostAt(now) {
      check(now);
      return lostWithSignals(now);
    },
    lostSinceAt(now) {
      check(now);
      return lostSince || (now >= since && lostWithSignals(now));
    },
  };
}

/**
 * Whether a Mic is lost at `now`, and whether it was lost at any moment since
 * `since`. `events` are in arrival order (Stage time never decreasing).
 */
export function micLost(
  events: readonly MicEvent[],
  { since, now }: MicLostQuery,
): MicLostState {
  const watch = createMicWatch(since);
  for (const { kind, at } of events) {
    if (at > now) break;
    watch.event(kind, at);
  }
  return { lostNow: watch.lostAt(now), lostSince: watch.lostSinceAt(now) };
}
