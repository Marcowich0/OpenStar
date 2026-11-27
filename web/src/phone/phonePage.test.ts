import { describe, expect, it } from "vitest";

import type { PartySnapshot } from "../generated/PartySnapshot";
import { initialLiveState, type LiveState } from "../live/liveState";
import {
  phonePage,
  startedAvSync,
  type PhonePageConditions,
} from "./phonePage";

const party: PartySnapshot = {
  partyId: "p1",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members: [
    {
      memberId: 1,
      identity: { kind: "profile", profileId: 7 },
      colour: "sky",
      favouriteTaken: false,
      onPhone: true,
      singing: false,
    },
  ],
  phones: [{ phoneId: "phone-a", memberId: 1 }],
  queue: [],
  head: null,
  lineUp: null,
  playing: null,
  results: null,
  localMics: [],
};

function live(memberId: number | null): LiveState {
  return {
    ...initialLiveState,
    connection: "open",
    stage: { stageId: "main", party, isStage: false, stageMoved: false },
    phone: { memberId, leftParty: false },
  };
}

const none: PhonePageConditions = {
  calibrating: () => false,
  avSync: () => false,
  micTakeover: () => false,
};

describe("the Phone page's state", () => {
  it("is the join flow while the Phone has not joined the current Party", () => {
    expect(phonePage(live(null), none)).toBe("joinFlow");
  });

  it("is the join flow while the server has not answered the Phone id yet", () => {
    expect(phonePage({ ...live(1), phone: null }, none)).toBe("joinFlow");
  });

  it("is the join flow when the Phone's member is not in the Party", () => {
    expect(phonePage(live(9), none)).toBe("joinFlow");
  });

  it("is the Remote for a joined Phone with nothing else going on", () => {
    expect(phonePage(live(1), none)).toBe("remote");
  });

  it("is the mic takeover over the Remote", () => {
    expect(phonePage(live(1), { ...none, micTakeover: () => true })).toBe(
      "micTakeover",
    );
  });

  it("is Calibrating (or Check A/V sync) over the mic takeover", () => {
    expect(
      phonePage(live(1), {
        ...none,
        calibrating: () => true,
        micTakeover: () => true,
      }),
    ).toBe("calibrating");
  });

  it("is the Check A/V sync controls over the mic takeover", () => {
    expect(
      phonePage(live(1), {
        ...none,
        avSync: () => true,
        micTakeover: () => true,
      }),
    ).toBe("avSync");
  });

  it("is the join flow over everything else", () => {
    expect(
      phonePage(live(null), {
        calibrating: () => true,
        avSync: () => true,
        micTakeover: () => true,
      }),
    ).toBe("joinFlow");
  });
});

describe("whether this Phone shows Check A/V sync as its page", () => {
  const running = (startedBy: string | null): LiveState => ({
    ...live(1),
    avSync: true,
    avSyncCheck: { startedBy, avOffsetMs: 40 },
  });

  it("is so for the Phone that started it, while it runs", () => {
    expect(startedAvSync(running("phone-a"), "phone-a")).toBe(true);
    expect(
      phonePage(running("phone-a"), {
        ...none,
        avSync: (s) => startedAvSync(s, "phone-a"),
      }),
    ).toBe("avSync");
  });

  it("is not so for any other Phone, nor when the Stage started it", () => {
    expect(startedAvSync(running("phone-b"), "phone-a")).toBe(false);
    expect(startedAvSync(running(null), "phone-a")).toBe(false);
  });

  it("is not so once it has ended", () => {
    expect(
      startedAvSync({ ...running("phone-a"), avSync: false }, "phone-a"),
    ).toBe(false);
  });
});
