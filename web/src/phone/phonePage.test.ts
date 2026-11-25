import { describe, expect, it } from "vitest";

import type { PartySnapshot } from "../generated/PartySnapshot";
import { initialLiveState, type LiveState } from "../live/liveState";
import { phonePage, type PhonePageConditions } from "./phonePage";

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
    },
  ],
  phones: [{ phoneId: "phone-a", memberId: 1 }],
  queue: [],
  head: null,
  lineUp: null,
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
      phonePage(live(1), { calibrating: () => true, micTakeover: () => true }),
    ).toBe("calibrating");
  });

  it("is the join flow over everything else", () => {
    expect(
      phonePage(live(null), {
        calibrating: () => true,
        micTakeover: () => true,
      }),
    ).toBe("joinFlow");
  });

  it("is the Remote with the store's own conditions, which later tickets fill in", () => {
    expect(phonePage(live(1))).toBe("remote");
  });
});
