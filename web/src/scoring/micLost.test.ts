import { describe, expect, it, vi } from "vitest";

import { createMicWatch, micLost, type MicEvent } from "./micLost";

// Times are Stage time in ms. The 1 s limit is #54's "Mic lost after no
// readings for 1 s"; the literals below are that spec value, not the constant.
const reading = (at: number): MicEvent => ({ kind: "reading", at });
const readingsEvery = (stepMs: number, from: number, to: number) => {
  const events: MicEvent[] = [];
  for (let at = from; at <= to; at += stepMs) events.push(reading(at));
  return events;
};

describe("the 1 s rule", () => {
  it("keeps a Mic present while readings keep arriving", () => {
    const events = readingsEvery(10, 0, 5000);
    expect(micLost(events, { since: 0, now: 5000 })).toEqual({
      lostNow: false,
      lostSince: false,
    });
  });

  it("does not lose a Mic over a gap just under 1 s", () => {
    const events = [reading(0), reading(999.9), reading(1500)];
    expect(micLost(events, { since: 0, now: 1500 })).toEqual({
      lostNow: false,
      lostSince: false,
    });
    expect(micLost(events, { since: 0, now: 999.8 }).lostNow).toBe(false);
  });

  it("loses a Mic over a gap of exactly 1 s", () => {
    const events = [reading(0), reading(1000), reading(1500)];
    expect(micLost(events, { since: 0, now: 1500 })).toEqual({
      lostNow: false,
      lostSince: true,
    });
    expect(micLost([reading(0)], { since: 0, now: 1000 }).lostNow).toBe(true);
    expect(micLost([reading(0)], { since: 0, now: 999.9 }).lostNow).toBe(false);
  });
});

describe("a closed connection", () => {
  it("loses the Mic at once, even with readings just before", () => {
    const events: MicEvent[] = [
      ...readingsEvery(10, 0, 500),
      { kind: "connectionClosed", at: 505 },
    ];
    expect(micLost(events, { since: 0, now: 504 }).lostNow).toBe(false);
    expect(micLost(events, { since: 0, now: 505 })).toEqual({
      lostNow: true,
      lostSince: true,
    });
  });

  it("comes back with the reconnect, not with a reading", () => {
    const events: MicEvent[] = [
      reading(0),
      { kind: "connectionClosed", at: 100 },
      reading(200),
      { kind: "connectionBack", at: 300 },
      reading(400),
    ];
    expect(micLost(events, { since: 0, now: 250 }).lostNow).toBe(true);
    expect(micLost(events, { since: 0, now: 300 })).toEqual({
      lostNow: false,
      lostSince: true,
    });
  });
});

describe("a hidden page", () => {
  it("loses the Mic at once, even while readings keep arriving", () => {
    const events: MicEvent[] = [
      reading(0),
      { kind: "pageHidden", at: 50 },
      ...readingsEvery(10, 60, 800),
    ];
    expect(micLost(events, { since: 0, now: 40 }).lostNow).toBe(false);
    expect(micLost(events, { since: 0, now: 800 }).lostNow).toBe(true);
  });

  it("comes back with the visible signal", () => {
    const events: MicEvent[] = [
      ...readingsEvery(10, 0, 900),
      { kind: "pageHidden", at: 100 },
      { kind: "pageVisible", at: 600 },
    ].sort((a, b) => a.at - b.at);
    expect(micLost(events, { since: 0, now: 599 }).lostNow).toBe(true);
    expect(micLost(events, { since: 0, now: 600 })).toEqual({
      lostNow: false,
      lostSince: true,
    });
  });

  it("stays lost while only one of two signals has ended", () => {
    const events: MicEvent[] = [
      reading(0),
      { kind: "pageHidden", at: 100 },
      { kind: "connectionClosed", at: 200 },
      { kind: "pageVisible", at: 300 },
      { kind: "connectionBack", at: 400 },
      reading(450),
    ];
    expect(micLost(events, { since: 0, now: 350 }).lostNow).toBe(true);
    expect(micLost(events, { since: 0, now: 400 }).lostNow).toBe(false);
  });
});

describe("the 1 s rule after coming back", () => {
  it("comes back with the next reading", () => {
    const events = [reading(0), reading(1800), reading(1810)];
    expect(micLost(events, { since: 0, now: 1799 }).lostNow).toBe(true);
    expect(micLost(events, { since: 0, now: 1800 })).toEqual({
      lostNow: false,
      lostSince: true,
    });
  });

  it("still applies after a reconnect with no reading since", () => {
    const events: MicEvent[] = [
      reading(0),
      { kind: "connectionClosed", at: 100 },
      { kind: "connectionBack", at: 2000 },
    ];
    expect(micLost(events, { since: 0, now: 2000 }).lostNow).toBe(true);
  });
});

describe("lost at any moment since the Song start", () => {
  it("stays set after the Mic comes back, for every kind of loss", () => {
    const back: MicEvent[][] = [
      [reading(0), reading(1200), ...readingsEvery(10, 1210, 5000)],
      [
        ...readingsEvery(10, 0, 5000),
        { kind: "connectionClosed", at: 1005 },
        { kind: "connectionBack", at: 1006 },
      ],
      [
        ...readingsEvery(10, 0, 5000),
        { kind: "pageHidden", at: 1005 },
        { kind: "pageVisible", at: 1006 },
      ],
    ].map((events) => [...events].sort((a, b) => a.at - b.at));
    for (const events of back) {
      expect(micLost(events, { since: 0, now: 5000 })).toEqual({
        lostNow: false,
        lostSince: true,
      });
    }
  });

  it("ignores a loss that ended before the start", () => {
    const events: MicEvent[] = [
      { kind: "connectionClosed", at: 0 },
      { kind: "connectionBack", at: 400 },
      reading(100),
      ...readingsEvery(10, 410, 3000),
    ].sort((a, b) => a.at - b.at);
    expect(micLost(events, { since: 500, now: 3000 }).lostSince).toBe(false);
    const silentBefore = [reading(0), ...readingsEvery(10, 2000, 4000)];
    expect(micLost(silentBefore, { since: 2005, now: 4000 }).lostSince).toBe(
      false,
    );
    // The moment the next reading arrives still ends the lost stretch.
    expect(micLost(silentBefore, { since: 2000, now: 4000 }).lostSince).toBe(
      true,
    );
  });

  it("counts a loss still going on at the start", () => {
    const events: MicEvent[] = [
      { kind: "pageHidden", at: 0 },
      { kind: "pageVisible", at: 600 },
      ...readingsEvery(10, 0, 3000),
    ].sort((a, b) => a.at - b.at);
    expect(micLost(events, { since: 500, now: 3000 })).toEqual({
      lostNow: false,
      lostSince: true,
    });
  });

  it("counts silence from the start when no reading has come yet", () => {
    expect(micLost([], { since: 2000, now: 2999 }).lostNow).toBe(false);
    expect(micLost([], { since: 2000, now: 3000 })).toEqual({
      lostNow: true,
      lostSince: true,
    });
    const late = [reading(2999), reading(3100)];
    expect(micLost(late, { since: 2000, now: 3100 }).lostSince).toBe(false);
  });

  it("counts silence from the last reading before the start", () => {
    const events = [reading(1100), reading(2500)];
    expect(micLost(events, { since: 2000, now: 2500 }).lostSince).toBe(true);
  });

  it("ignores events after now", () => {
    const events: MicEvent[] = [
      reading(0),
      { kind: "connectionClosed", at: 500 },
    ];
    expect(micLost(events, { since: 0, now: 400 })).toEqual({
      lostNow: false,
      lostSince: false,
    });
  });
});

describe("what the rule never reads", () => {
  it("keeps a Mic sending readings of silence present", () => {
    // Events carry only a kind and a time: a reading of silence, of an unvoiced
    // sound or of a sung Note is the same "reading arrived" to this rule.
    const events = readingsEvery(10, 0, 10_000);
    expect(micLost(events, { since: 0, now: 10_000 }).lostSince).toBe(false);
  });
});

describe("the live watch", () => {
  it("agrees with the pure function at every event", () => {
    const events: MicEvent[] = [
      reading(0),
      reading(990),
      { kind: "pageHidden", at: 1500 },
      reading(1600),
      { kind: "pageVisible", at: 1700 },
      { kind: "connectionClosed", at: 1800 },
      { kind: "connectionBack", at: 3000 },
      reading(3100),
      reading(4100),
    ];
    const watch = createMicWatch(500);
    for (const [i, event] of events.entries()) {
      watch.event(event.kind, event.at);
      const pure = micLost(events.slice(0, i + 1), {
        since: 500,
        now: event.at,
      });
      expect({
        lostNow: watch.lostAt(event.at),
        lostSince: watch.lostSinceAt(event.at),
      }).toEqual(pure);
    }
  });

  it("refuses events out of Stage-time order", () => {
    const watch = createMicWatch(0);
    watch.event("reading", 100);
    expect(() => watch.event("reading", 99)).toThrow();
    expect(() => watch.lostAt(50)).toThrow();
  });
});

describe("the 1 s limit", () => {
  it("comes from the scoring constants module", async () => {
    vi.resetModules();
    vi.doMock("./constants", () => ({ SCORING: { micLostAfterMs: 250 } }));
    const { micLost: withLimit } = await import("./micLost");
    expect(withLimit([reading(0)], { since: 0, now: 250 }).lostNow).toBe(true);
    expect(withLimit([reading(0)], { since: 0, now: 249 }).lostNow).toBe(false);
    vi.doUnmock("./constants");
    vi.resetModules();
  });
});
