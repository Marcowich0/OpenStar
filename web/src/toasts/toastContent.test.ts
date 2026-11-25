import { describe, expect, it } from "vitest";

import type { PartyEvent } from "../generated/PartyEvent";
import type { PartySnapshot } from "../generated/PartySnapshot";
import type { Profile } from "../generated/Profile";
import type { Toast } from "../live/toasts";
import { tParts, type TextPart } from "../i18n/t";
import { BOLD_PARAMS, toastContent } from "./toastContent";

const party: PartySnapshot = {
  partyId: "p",
  stageId: "main",
  joinCode: "4821",
  startedAtMs: 1,
  members: [
    {
      memberId: 1,
      identity: { kind: "profile", profileId: 7 },
      colour: "tangerine",
      favouriteTaken: false,
      onPhone: true,
      singing: false,
    },
    {
      memberId: 2,
      identity: {
        kind: "guest",
        name: "Mia",
        avatar: { kind: "builtIn", key: "heart" },
        difficulty: "medium",
      },
      colour: "mint",
      favouriteTaken: false,
      onPhone: true,
      singing: false,
    },
  ],
  phones: [],
  queue: [],
  head: null,
  lineUp: null,
  playing: null,
  results: null,
};

const profiles: Profile[] = [
  {
    id: 7,
    name: "Bo",
    avatar: { kind: "builtIn", key: "cat" },
    favouriteColour: "cherry",
    lastDifficulty: "medium",
    createdAt: 1,
    lastSungAt: null,
  },
];

const africa = { requestId: 3, songId: 9, title: "Africa" };

const byMember = (memberId: number, event: PartyEvent): Toast => ({
  id: 0,
  actor: { kind: "member", memberId },
  event,
});

const text = (toast: Toast, given = party, known = profiles) =>
  toastContent(toast, given, known)
    .parts.map((part) => part.text)
    .join("");

describe("a toast's content", () => {
  it("names the Remote's Party member and the Song", () => {
    const content = toastContent(
      byMember(1, { code: "requestMovedUp", params: africa }),
      party,
      profiles,
    );
    expect(content.parts).toEqual([
      { text: "Bo", param: "actor" },
      { text: " moved " },
      { text: "Africa", param: "song" },
      { text: " up" },
    ]);
    expect(content.actor).toEqual({
      name: "Bo",
      avatar: { kind: "builtIn", key: "cat" },
      colour: "tangerine",
    });
  });

  it("says who changed the Queue, for every Queue change", () => {
    const cases: [PartyEvent["code"], string][] = [
      ["requestAdded", "Mia added Africa"],
      ["requestMovedUp", "Mia moved Africa up"],
      ["requestMovedDown", "Mia moved Africa down"],
      ["requestPlayNext", "Mia made Africa play next"],
      ["requestRemoved", "Mia removed Africa"],
      ["requestedPlayersChanged", "Mia changed who sings Africa"],
    ];
    for (const [code, expected] of cases) {
      const event = { code, params: africa } as PartyEvent;
      expect(text(byMember(2, event))).toBe(expected);
    }
  });

  it("says who started, paused, resumed, restarted, ended or skipped the Song", () => {
    const cases: [PartyEvent["code"], string][] = [
      ["songStarted", "Mia started Africa"],
      ["songPaused", "Mia paused the Song"],
      ["songResumed", "Mia resumed the Song"],
      ["songRestarted", "Mia restarted Africa"],
      ["songEnded", "Mia ended Africa early"],
      ["songSkipped", "Mia skipped Africa"],
    ];
    for (const [code, expected] of cases) {
      const event = { code, params: africa } as PartyEvent;
      expect(text(byMember(2, event))).toBe(expected);
    }
    expect(text(byMember(2, { code: "resultsClosed" }))).toBe(
      "Mia moved on from the results",
    );
    const shown: Toast = {
      id: 0,
      actor: { kind: "stage" },
      event: { code: "resultsShown", params: africa },
    };
    expect(text(shown)).toBe("The results of Africa");
  });

  it("says who edited the Line-up, and how", () => {
    expect(text(byMember(2, { code: "lineUpChanged" }))).toBe(
      "Mia changed the Line-up",
    );
    expect(
      text(
        byMember(2, { code: "seatMoved", params: { memberId: 1, name: "Bo" } }),
      ),
    ).toBe("Mia moved Bo to another seat");
    expect(
      text(
        byMember(2, {
          code: "seatVoice",
          params: { memberId: 1, name: "Bo", voice: "p2" },
        }),
      ),
    ).toBe("Mia put Bo on Voice 2");
    expect(
      text(
        byMember(1, {
          code: "seatDifficulty",
          params: { memberId: 1, name: "Bo", difficulty: "hard" },
        }),
      ),
    ).toBe("Bo set Bo to Hard");
    const next = byMember(2, {
      code: "nextDifficulty",
      params: { memberId: 2, name: "Mia", difficulty: "easy" },
    });
    expect(text(next)).toBe("Mia sings on Easy next");
    expect(toastContent(next, party, profiles).actor?.name).toBe("Mia");
  });

  it("names a joining member with their colour's display name", () => {
    const toast = byMember(2, {
      code: "memberJoined",
      params: { memberId: 2, name: "Mia", colour: "mint" },
    });
    expect(text(toast)).toBe("Mia joined the Party in Mint");
    expect(toastContent(toast, party, profiles).actor?.colour).toBe("mint");
  });

  it("shows a member who left with the look they had, from the event alone", () => {
    // Lukas is no longer in the snapshot; Bo removed him.
    const toast = byMember(1, {
      code: "memberLeft",
      params: {
        memberId: 5,
        name: "Lukas",
        avatar: { kind: "builtIn", key: "moon" },
        colour: "tangerine",
      },
    });
    const content = toastContent(toast, party, profiles);
    expect(text(toast)).toBe("Lukas left the Party. Tangerine is free");
    expect(content.parts.filter((part) => part.param === "actor")).toEqual([
      { text: "Lukas", param: "actor" },
    ]);
    expect(content.actor).toEqual({
      name: "Lukas",
      avatar: { kind: "builtIn", key: "moon" },
      colour: "tangerine",
    });
  });

  it("falls back to the text without the actor while their name is unknown", () => {
    const toast = byMember(1, { code: "requestRemoved", params: africa });
    expect(text(toast, party, [])).toBe("Africa was removed from the Queue");
    expect(toastContent(toast, party, []).actor).toBeNull();
  });

  it("shows no avatar for a change the Stage made", () => {
    const content = toastContent(
      {
        id: 0,
        actor: { kind: "stage" },
        event: { code: "partyStarted", params: { joinCode: "4821" } },
      },
      party,
      profiles,
    );
    expect(content.actor).toBeNull();
    expect(content.parts.map((part) => part.text).join("")).toBe(
      "New party started, Join code 4821",
    );
  });
});

describe("a Phone's own changes", () => {
  // This Phone's Party member is Bo (member 1).
  const mine = (toast: Toast) =>
    toastContent(toast, party, profiles, 1)
      .parts.map((part) => part.text)
      .join("");

  it("toast in the second person, with the Phone's own avatar", () => {
    const toast = byMember(1, { code: "requestMovedUp", params: africa });
    const content = toastContent(toast, party, profiles, 1);
    expect(content.parts).toEqual([
      { text: "You moved " },
      { text: "Africa", param: "song" },
      { text: " up" },
    ]);
    expect(content.actor?.name).toBe("Bo");
  });

  it("say “you” for every Queue change", () => {
    const cases: [PartyEvent["code"], string][] = [
      ["requestAdded", "You added Africa"],
      ["requestMovedUp", "You moved Africa up"],
      ["requestMovedDown", "You moved Africa down"],
      ["requestPlayNext", "You made Africa play next"],
      ["requestRemoved", "You removed Africa"],
      ["requestedPlayersChanged", "You changed who sings Africa"],
    ];
    for (const [code, expected] of cases) {
      const event = { code, params: africa } as PartyEvent;
      expect(mine(byMember(1, event))).toBe(expected);
    }
  });

  it("say “you” for the Song controls and leaving the results", () => {
    const cases: [PartyEvent["code"], string][] = [
      ["songStarted", "You started Africa"],
      ["songPaused", "You paused Africa"],
      ["songResumed", "You resumed Africa"],
      ["songRestarted", "You restarted Africa"],
      ["songEnded", "You ended Africa early"],
      ["songSkipped", "You skipped Africa"],
    ];
    for (const [code, expected] of cases) {
      const event = { code, params: africa } as PartyEvent;
      expect(mine(byMember(1, event))).toBe(expected);
    }
    expect(mine(byMember(1, { code: "resultsClosed" }))).toBe(
      "You moved on from the results",
    );
  });

  it("say where this Phone's own new Request is in the Queue", () => {
    const request = (requestId: number) => ({
      requestId,
      kind: "song" as const,
      songId: 9,
      requestedPlayers: [],
      adder: 1,
    });
    const queued = {
      ...party,
      queue: [1, 2, 4, 5, 3].map(request),
      head: 1,
    };
    const toast = byMember(1, { code: "requestAdded", params: africa });
    const content = toastContent(toast, queued, profiles, 1);
    expect(content.parts.map((part) => part.text).join("")).toBe(
      "Africa added, number 5",
    );
    expect(content.parts[0]).toEqual({ text: "Africa", param: "song" });
  });

  it("say “you” for changes about this Phone's member", () => {
    expect(
      mine(
        byMember(1, {
          code: "memberJoined",
          params: { memberId: 1, name: "Bo", colour: "tangerine" },
        }),
      ),
    ).toBe("You joined the Party in Tangerine");
    expect(
      mine(
        byMember(1, {
          code: "phoneJoined",
          params: { memberId: 1, name: "Bo" },
        }),
      ),
    ).toBe("You joined on one more Phone");
    expect(
      mine(
        byMember(1, {
          code: "memberChanged",
          params: { memberId: 1, name: "Bo" },
        }),
      ),
    ).toBe("You changed your name, look or colour");
    expect(
      mine(
        byMember(1, {
          code: "micBlocked",
          params: { memberId: 1, name: "Bo" },
        }),
      ),
    ).toBe("Your mic is blocked");
    expect(
      mine(
        byMember(1, { code: "micOpened", params: { memberId: 1, name: "Bo" } }),
      ),
    ).toBe("Your mic is on");
  });

  it("stay in the third person for other members and the Stage", () => {
    expect(mine(byMember(2, { code: "requestMovedUp", params: africa }))).toBe(
      "Mia moved Africa up",
    );
    expect(
      mine({
        id: 0,
        actor: { kind: "stage" },
        event: { code: "requestRemoved", params: africa },
      }),
    ).toBe("Africa was removed from the Queue");
  });

  it("say “you” even while this Phone's Profile is not loaded", () => {
    const toast = byMember(1, { code: "requestRemoved", params: africa });
    const content = toastContent(toast, party, [], 1);
    expect(content.parts.map((part) => part.text).join("")).toBe(
      "You removed Africa",
    );
    expect(content.actor).toBeNull();
  });
});

// Synthetic events for the toasts whose server side is not built yet: the
// texts are in the catalogue, ready for the ticket that adds each code.
describe("toasts whose sender is not built yet", () => {
  const join = (parts: TextPart[]) => parts.map((part) => part.text).join("");
  const bold = (parts: TextPart[]) =>
    parts
      .filter((part) => part.param && BOLD_PARAMS.has(part.param))
      .map((part) => part.text);

  it("says a mic is back", () => {
    expect(join(tParts("toast.backOnMic", { actor: "Mia" }))).toBe(
      "Mia is back on the mic",
    );
    expect(
      join(tParts("toast.localMicBack", { mic: "Mic 2", actor: "Mia" })),
    ).toBe("Mic 2 is back on Mia's seat");
  });

  it("asks for calibration when the sound output changed", () => {
    expect(join(tParts("toast.soundOutputChanged"))).toBe(
      "Sound output changed: calibrate mics",
    );
  });

  it("says why a queued Request was dropped", () => {
    expect(
      join(tParts("toast.requestDroppedSongGone", { song: "Africa" })),
    ).toBe("Africa left the Library and was taken off the Queue");
    const parts = tParts("toast.requestDroppedProfileDeleted", {
      song: "Africa",
      name: "Bo",
    });
    expect(join(parts)).toBe(
      "Africa was taken off the Queue: Bo's Profile was deleted",
    );
    expect(bold(parts)).toEqual(["Africa", "Bo"]);
  });

  it("names the Remote behind a Line-up change, pause, resume and Auto-fit", () => {
    expect(join(tParts("toast.lineUpChanged", { actor: "Sara" }))).toBe(
      "Sara changed the Line-up",
    );
    expect(
      join(
        tParts("toast.seatVoice", { actor: "Jonas", name: "Emil", voice: 2 }),
      ),
    ).toBe("Jonas put Emil on Voice 2");
    expect(
      join(
        tParts("toast.seatDifficulty", {
          actor: "Mia",
          name: "Bo",
          difficulty: "Hard",
        }),
      ),
    ).toBe("Mia set Bo to Hard");
    expect(join(tParts("toast.paused", { actor: "Sara" }))).toBe(
      "Sara paused the Song",
    );
    expect(join(tParts("toast.resumed", { actor: "Sara" }))).toBe(
      "Sara resumed the Song",
    );
    expect(
      join(tParts("toast.autoFitAccepted", { actor: "Bo", song: "Africa" })),
    ).toBe("Bo accepted the Auto-fit of Africa");
  });
});
