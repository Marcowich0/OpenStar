import { describe, expect, it } from "vitest";

import type { PartyEvent } from "../../generated/PartyEvent";
import type { PartySnapshot } from "../../generated/PartySnapshot";
import type { Profile } from "../../generated/Profile";
import type { Toast } from "../../live/toasts";
import { colourName } from "../../i18n/colourNames";
import { tParts, type TextPart } from "../../i18n/t";
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
    },
  ],
  phones: [],
  queue: [],
  head: null,
  lineUp: null,
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

describe("a Stage toast's content", () => {
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

  it("names a joining member with their colour's display name", () => {
    const toast = byMember(2, {
      code: "memberJoined",
      params: { memberId: 2, name: "Mia", colour: "mint" },
    });
    expect(text(toast)).toBe("Mia joined the Party in Mint");
    expect(toastContent(toast, party, profiles).actor?.colour).toBe("mint");
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

// Synthetic events for the toasts whose server side is not built yet: the
// texts are in the catalogue, ready for the ticket that adds each code.
describe("toasts whose sender is not built yet", () => {
  const join = (parts: TextPart[]) => parts.map((part) => part.text).join("");
  const bold = (parts: TextPart[]) =>
    parts
      .filter((part) => part.param && BOLD_PARAMS.has(part.param))
      .map((part) => part.text);

  it("says a member left and names the colour that is free", () => {
    const parts = tParts("toast.memberLeft", {
      actor: "Lukas",
      colour: colourName("cocoa"),
    });
    expect(join(parts)).toBe("Lukas left the Party. Cocoa is free");
    expect(bold(parts)).toEqual(["Lukas"]);
  });

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
