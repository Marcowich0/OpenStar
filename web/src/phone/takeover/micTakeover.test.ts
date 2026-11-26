import { describe, expect, it } from "vitest";

import type { PartySnapshot } from "../../generated/PartySnapshot";
import { initialLiveState, type LiveState } from "../../live/liveState";
import type { PhoneMicSnapshot } from "../mic/phoneMic";
import {
  BO_SEAT,
  JONAS_SEAT,
  LINE_UP,
  MY_PHONE,
  PARTY,
} from "../stage/testParty";
import { micTakeover } from "./micTakeover";

const live = (
  party: PartySnapshot | null,
  rest: Partial<LiveState> = {},
): LiveState => ({
  ...initialLiveState,
  stage: { stageId: "main", party, isStage: false, stageMoved: false },
  ...rest,
});

const mic = (
  state: PhoneMicSnapshot["state"],
  blocked: PhoneMicSnapshot["blocked"] = null,
): Pick<PhoneMicSnapshot, "state" | "blocked"> => ({ state, blocked });

/** Valerie (40) plays with Bo and Jonas seated. */
const PLAYING: PartySnapshot = {
  ...PARTY,
  playing: { requestId: 1, songId: 40, paused: false },
};

describe("micTakeover", () => {
  it("is seated while this Phone is a seat's Mic and its mic is off", () => {
    expect(micTakeover(live(PARTY), MY_PHONE, mic("off"))).toEqual({
      step: "seated",
      seat: BO_SEAT,
      seatIndex: 0,
      memberId: 1,
      colour: "cherry",
      duet: false,
      requestId: 1,
      songId: 40,
      canStart: true,
      started: false,
      score: null,
      blocked: null,
    });
  });

  it("is the seated Player's, who need not be this Phone's own member", () => {
    const sara = { ...BO_SEAT, memberId: 3 };
    const party = { ...PARTY, lineUp: { ...LINE_UP, seats: [sara] } };
    expect(micTakeover(live(party), MY_PHONE, mic("off"))).toMatchObject({
      memberId: 3,
      colour: "lime",
    });
  });

  it("shows no takeover when no seat names this Phone", () => {
    const without = { ...PARTY, lineUp: { ...LINE_UP, seats: [JONAS_SEAT] } };
    expect(micTakeover(live(without), MY_PHONE, mic("off"))).toBeNull();
    expect(micTakeover(live(without), MY_PHONE, mic("on"))).toBeNull();
    expect(
      micTakeover(live({ ...PARTY, lineUp: null }), MY_PHONE, mic("on")),
    ).toBeNull();
    expect(micTakeover(initialLiveState, MY_PHONE, mic("off"))).toBeNull();
  });

  it("is opening between the tap and the mic being on", () => {
    expect(micTakeover(live(PARTY), MY_PHONE, mic("opening"))?.step).toBe(
      "opening",
    );
  });

  it("is mic on before Start, also for a mic kept open from the previous Song", () => {
    // The previous Song's mic stayed on through its results; the next
    // Line-up seats this Phone again, so the takeover skips Seated.
    const next = {
      ...PARTY,
      head: 2,
      lineUp: { ...LINE_UP, requestId: 2, canStart: false },
      queue: PARTY.queue.map((r) => ({ ...r, requestId: 2, songId: 41 })),
    };
    expect(micTakeover(live(next), MY_PHONE, mic("on"))).toMatchObject({
      step: "micOn",
      requestId: 2,
      songId: 41,
      canStart: false,
    });
  });

  it("is singing once the Song started with the mic on, with the Score from the server", () => {
    const state = live(PLAYING, { lineScore: { requestId: 1, total: 2350 } });
    expect(micTakeover(state, MY_PHONE, mic("on"))).toMatchObject({
      step: "singing",
      started: true,
      score: 2350,
    });
  });

  it("ignores a Score reported for another Song", () => {
    const state = live(PLAYING, { lineScore: { requestId: 9, total: 2350 } });
    expect(micTakeover(state, MY_PHONE, mic("on"))?.score).toBeNull();
  });

  it("still offers Turn on my mic when the Song started before the mic was on", () => {
    expect(micTakeover(live(PLAYING), MY_PHONE, mic("off"))).toMatchObject({
      step: "seated",
      started: true,
    });
  });

  it("is blocked, with the reason, when the mic could not open", () => {
    expect(
      micTakeover(live(PARTY), MY_PHONE, mic("failed", "noHttps")),
    ).toMatchObject({ step: "blocked", blocked: "noHttps" });
  });

  it("is lost after the page was hidden", () => {
    expect(micTakeover(live(PLAYING), MY_PHONE, mic("lost"))?.step).toBe(
      "lost",
    );
  });

  it("names the Voice only in a duet", () => {
    const duet = { ...PARTY, lineUp: { ...LINE_UP, duet: true } };
    expect(micTakeover(live(duet), MY_PHONE, mic("off"))?.duet).toBe(true);
  });
});
