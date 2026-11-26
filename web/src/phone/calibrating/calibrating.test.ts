import { describe, expect, it } from "vitest";

import type { CalibrationRun } from "../../generated/CalibrationRun";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import { initialLiveState, type LiveState } from "../../live/liveState";
import type { PhoneMicSnapshot } from "../mic/phoneMic";
import { phonePage } from "../phonePage";
import { MY_PHONE, PARTY } from "../stage/testParty";
import { isSeatedMic } from "../takeover/micTakeover";
import {
  calibrating,
  isCalibrating,
  TONES_RUN_MS,
  tonesProgress,
} from "./calibrating";

const ME = { kind: "phone", phoneId: MY_PHONE } as const;
const JONAS = { kind: "phone", phoneId: "jonas-phone" } as const;

const live = (
  run: CalibrationRun | null,
  party: PartySnapshot = PARTY,
): LiveState => ({
  ...initialLiveState,
  connection: "open",
  stage: { stageId: "main", party, isStage: false, stageMoved: false },
  phone: { memberId: 1, leftParty: false },
  calibration: run,
});

const run = (
  phase: CalibrationRun["phase"],
  ready = false,
  mics = [ME, JONAS],
): CalibrationRun => ({
  phase,
  mics: mics.map((mic) => ({ mic, chosen: true, ready })),
});

const mic = (
  state: PhoneMicSnapshot["state"],
  blocked: PhoneMicSnapshot["blocked"] = null,
) => ({ state, blocked });

describe("the Calibrating takeover's state", () => {
  it("shows I'm listening on a chosen Phone once the run waits for its Mics", () => {
    expect(calibrating(live(run("waiting")), MY_PHONE, mic("off"))).toEqual({
      step: "listen",
      colour: "cherry",
      blocked: null,
    });
  });

  it("is in this Phone's own Party colour, not a seated Player's", () => {
    const sky = {
      ...PARTY,
      members: PARTY.members.map((m) =>
        m.memberId === 1 ? { ...m, colour: "sky" as const } : m,
      ),
    };
    expect(
      calibrating(live(run("waiting"), sky), MY_PHONE, mic("off"))?.colour,
    ).toBe("sky");
  });

  it("is not shown on the checklist, after the run, or on a Phone not chosen", () => {
    expect(calibrating(live(run("choosing")), MY_PHONE, mic("off"))).toBeNull();
    expect(calibrating(live(run("results")), MY_PHONE, mic("on"))).toBeNull();
    expect(calibrating(live(null), MY_PHONE, mic("off"))).toBeNull();
    expect(
      calibrating(live(run("waiting", false, [JONAS])), MY_PHONE, mic("off")),
    ).toBeNull();
    // Not ready by Go: the tones go on without this Phone.
    expect(
      calibrating(live(run("tones", true, [JONAS])), MY_PHONE, mic("on")),
    ).toBeNull();
  });

  it("follows the mic from the tap to ready", () => {
    const waiting = live(run("waiting"));
    expect(calibrating(waiting, MY_PHONE, mic("opening"))?.step).toBe(
      "opening",
    );
    // Open, but the server has not heard "I'm listening" (a seated Phone's
    // mic that was already on): the tap is still needed.
    expect(calibrating(waiting, MY_PHONE, mic("on"))?.step).toBe("listen");
    expect(
      calibrating(live(run("waiting", true)), MY_PHONE, mic("on"))?.step,
    ).toBe("ready");
  });

  it("asks for the tap again when the mic stopped after it was ready", () => {
    expect(
      calibrating(live(run("waiting", true)), MY_PHONE, mic("lost"))?.step,
    ).toBe("listen");
  });

  it("says why the mic did not open", () => {
    expect(
      calibrating(
        live(run("waiting")),
        MY_PHONE,
        mic("failed", "permissionRefused"),
      ),
    ).toEqual({
      step: "blocked",
      colour: "cherry",
      blocked: "permissionRefused",
    });
  });

  it("shows the tones while this Phone takes part in them", () => {
    expect(
      calibrating(live(run("tones", true)), MY_PHONE, mic("on"))?.step,
    ).toBe("tones");
  });
});

describe("the Phone page during a Calibration run", () => {
  const page = (state: LiveState) =>
    phonePage(state, {
      calibrating: (s) => isCalibrating(s, MY_PHONE),
      avSync: () => false,
      micTakeover: (s) => isSeatedMic(s, MY_PHONE),
    });

  it("is Calibrating above the mic takeover of a seated Phone", () => {
    // PARTY seats this Phone in the Line-up.
    expect(page(live(null))).toBe("micTakeover");
    expect(page(live(run("waiting")))).toBe("calibrating");
    expect(page(live(run("tones", true)))).toBe("calibrating");
  });

  it("is Calibrating above the Remote, and back to what it showed after", () => {
    const browsing = { ...PARTY, head: null, lineUp: null };
    expect(page(live(run("waiting"), browsing))).toBe("calibrating");
    expect(page(live(run("results"), browsing))).toBe("remote");
    expect(page(live(run("results")))).toBe("micTakeover");
  });

  it("still joins first: a Phone outside the Party sees the join flow", () => {
    const outside = {
      ...live(run("waiting")),
      phone: { memberId: null, leftParty: false },
    };
    expect(page(outside)).toBe("joinFlow");
  });
});

describe("the tones' progress", () => {
  it("runs from 0 to 1 over the 8 tones and the listening after them", () => {
    // 8 tones 600 ms apart, the last 200 ms long, then 1.2 s more listening.
    expect(TONES_RUN_MS).toBe(7 * 600 + 200 + 1200);
    expect(tonesProgress(0)).toBe(0);
    expect(tonesProgress(TONES_RUN_MS / 2)).toBeCloseTo(0.5);
    expect(tonesProgress(TONES_RUN_MS * 3)).toBe(1);
    expect(tonesProgress(-50)).toBe(0);
  });
});
