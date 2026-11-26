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
import {
  playerResult,
  songResults,
} from "../../stage/scenes/results/testResults";
import { micTakeover, takeoverShows } from "./micTakeover";

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
    expect(micTakeover(state, MY_PHONE, mic("on"))).toMatchObject({
      score: null,
    });
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
    expect(micTakeover(live(duet), MY_PHONE, mic("off"))).toMatchObject({
      duet: true,
    });
  });

  it("goes back to Turn on my mic when the mic was lost before Start", () => {
    // "The Song kept going" would not be true yet.
    expect(micTakeover(live(PARTY), MY_PHONE, mic("lost"))?.step).toBe(
      "seated",
    );
  });
});

/** The results of Request 1: Bo sang on this Phone, Jonas on the Red mic. */
const BO_RESULT = playerResult({
  memberId: 1,
  colour: "cherry",
  mic: { kind: "phone", phoneId: MY_PHONE },
  total: 6420,
  rankTitleBand: 5,
  newHighScore: true,
});
const JONAS_RESULT = playerResult({
  memberId: 2,
  name: "Jonas",
  colour: "teal",
  mic: { kind: "localMic", localMicId: "red" },
  total: 7000,
});
const RESULTS: PartySnapshot = {
  ...PARTY,
  head: null,
  lineUp: null,
  queue: [],
  results: songResults([JONAS_RESULT, BO_RESULT], { songId: 40 }),
};

describe("micTakeover after the Song", () => {
  it("shows this Phone's own result while the Stage is on the results", () => {
    expect(micTakeover(live(RESULTS), MY_PHONE, mic("on"))).toEqual({
      step: "after",
      requestId: 1,
      songId: 40,
      memberId: 1,
      colour: "cherry",
      result: BO_RESULT,
    });
  });

  it("marks a Player who did not finish", () => {
    const ended = {
      ...RESULTS,
      results: songResults([{ ...BO_RESULT, unfinished: true }], {
        songId: 40,
        ended: "ended",
      }),
    };
    expect(micTakeover(live(ended), MY_PHONE, mic("on"))).toMatchObject({
      step: "after",
      result: { unfinished: true },
    });
  });

  it("shows the result to a Phone back after the Song, whatever its mic did", () => {
    // The Phone locked during the Song and returns once it is over.
    for (const state of ["lost", "off", "failed"] as const) {
      expect(micTakeover(live(RESULTS), MY_PHONE, mic(state))?.step).toBe(
        "after",
      );
    }
  });

  it("gives way to the Remote once the Stage has left the results", () => {
    const next = { ...RESULTS, results: null };
    expect(micTakeover(live(next), MY_PHONE, mic("lost"))).toBeNull();
    expect(takeoverShows(live(next), MY_PHONE, null)).toBe(false);
  });

  it("gives way to the Remote after Done", () => {
    expect(micTakeover(live(RESULTS), MY_PHONE, mic("on"), 1)).toBeNull();
    expect(takeoverShows(live(RESULTS), MY_PHONE, 1)).toBe(false);
    // Done for an earlier Song does not hide this one's result.
    expect(micTakeover(live(RESULTS), MY_PHONE, mic("on"), 0)?.step).toBe(
      "after",
    );
  });

  it("shows nothing to a Phone that was no Player's Mic", () => {
    expect(micTakeover(live(RESULTS), "jonas-phone", mic("off"))).toBeNull();
    expect(takeoverShows(live(RESULTS), "jonas-phone", null)).toBe(false);
  });

  it("is the page while seated or showing its own result", () => {
    expect(takeoverShows(live(RESULTS), MY_PHONE, null)).toBe(true);
    expect(takeoverShows(live(PARTY), MY_PHONE, null)).toBe(true);
    expect(takeoverShows(live(PARTY), "sara-phone", null)).toBe(false);
  });
});
