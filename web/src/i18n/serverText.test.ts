import { describe, expect, it } from "vitest";

import { t } from "./t";
import {
  apiErrorText,
  byCode,
  libraryReadOnlyText,
  partyEventText,
  txtRejectionText,
  txtWarningText,
  userMessageText,
} from "./serverText";

describe("server texts", () => {
  it("turns a UserMessage code and its parameters into text", () => {
    expect(userMessageText({ code: "notTheStage" })).toBe(
      "Only the Stage can do that",
    );
    expect(userMessageText({ code: "serverError" })).toBe(
      "Something went wrong on the server",
    );
  });

  it("turns a Party change into toast text", () => {
    expect(
      partyEventText({ code: "partyStarted", params: { joinCode: "0427" } }),
    ).toBe("New party started, Join code 0427");
    expect(
      partyEventText({
        code: "memberJoined",
        params: { memberId: 1, name: "Bo", colour: "tangerine" },
      }),
    ).toBe("Bo joined the Party in Tangerine");
    expect(
      partyEventText({
        code: "phoneJoined",
        params: { memberId: 1, name: "Bo" },
      }),
    ).toBe("Bo joined on another Phone");
  });

  it("turns join refusals into the Phone's text", () => {
    expect(userMessageText({ code: "joinCodeWrong" })).toBe(
      "That code is not on the Stage",
    );
    expect(userMessageText({ code: "partyFull" })).toBe("Party is full");
    expect(userMessageText({ code: "notInParty" })).toBe(
      "Join the Party first",
    );
  });

  it("turns an HTTP error code into text", () => {
    expect(apiErrorText({ code: "wrongPin" })).toBe(
      "That is not the Admin PIN",
    );
  });

  it("turns the Library's read-only reason into text", () => {
    expect(
      libraryReadOnlyText({
        code: "songsFolderMissing",
        songsDir: "/songs",
      }),
    ).toBe(
      "The songs folder /songs does not exist, so the Library is read-only",
    );
  });

  it("turns Library problem reasons into text", () => {
    expect(txtRejectionText({ code: "invalidBpm", line: 4 })).toBe(
      "Line 4: the #BPM is not valid",
    );
    expect(
      txtWarningText({ code: "overlappingNotes", line: 12, earlierLine: 11 }),
    ).toBe("Line 12: the Note overlaps the one on line 11");
    expect(
      txtWarningText({ code: "duplicateHeader", line: 3, header: "TITLE" }),
    ).toBe("Line 3: #TITLE appears more than once");
  });
});

describe("toasts", () => {
  // The shape every structured toast event has on the wire: a code plus its
  // parameters, such as who acted and on which Song. The generated union of
  // toast events comes with the first area that sends one; it is rendered
  // with `byCode` the same way.
  type ToastEvent =
    | { code: "songMovedUp"; params: { actor: string; song: string } }
    | { code: "backOnMic"; params: { actor: string } };

  const toastText = byCode<ToastEvent>({
    songMovedUp: ({ params }) => t("toast.songMovedUp", params),
    backOnMic: ({ params }) => t("toast.backOnMic", params),
  });

  it("renders an event with an actor and a Song through t()", () => {
    expect(
      toastText({
        code: "songMovedUp",
        params: { actor: "Bo", song: "Africa" },
      }),
    ).toBe("Bo moved Africa up");
    expect(toastText({ code: "backOnMic", params: { actor: "Mia" } })).toBe(
      "Mia is back on the mic",
    );
  });
});
