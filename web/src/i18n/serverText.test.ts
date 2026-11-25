import { describe, expect, it } from "vitest";

import { colourName } from "./colourNames";
import { en } from "./en";
import type { PaletteKey } from "../theme/tokens";
import { t } from "./t";
import {
  apiErrorText,
  byCode,
  libraryReadOnlyText,
  lineUpWarningText,
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

  it("turns a job failure into text", () => {
    expect(
      userMessageText({
        code: "toolFailed",
        params: { tool: "ffmpeg", exitCode: 1 },
      }),
    ).toBe("ffmpeg failed with exit code 1");
    expect(
      userMessageText({
        code: "toolFailed",
        params: { tool: "yt-dlp", exitCode: null },
      }),
    ).toBe("yt-dlp was stopped before it finished");
    expect(
      userMessageText({ code: "toolNotFound", params: { tool: "ffprobe" } }),
    ).toBe("ffprobe is not installed on the server");
    expect(userMessageText({ code: "jobCancelled" })).toBe("Cancelled");
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
    expect(
      partyEventText({
        code: "memberChanged",
        params: { memberId: 1, name: "Bo" },
      }),
    ).toBe("Bo changed their name, look or colour");
    const africa = { requestId: 4, songId: 12, title: "Africa" };
    expect(partyEventText({ code: "requestMovedUp", params: africa })).toBe(
      "Africa moved up",
    );
    expect(partyEventText({ code: "requestPlayNext", params: africa })).toBe(
      "Africa plays next",
    );
  });

  it("turns Line-up warnings into text with the member's name", () => {
    const nameOf = (memberId: number) => (memberId === 2 ? "Bo" : "?");
    expect(
      lineUpWarningText({ code: "noMic", params: { memberId: 2 } }, nameOf),
    ).toBe("Bo has no mic");
    expect(
      lineUpWarningText(
        { code: "micBlocked", params: { memberId: 2 } },
        nameOf,
      ),
    ).toBe("Bo's mic is blocked");
    expect(
      lineUpWarningText(
        { code: "duetNeedsVoice", params: { voice: "p2" } },
        nameOf,
      ),
    ).toBe("A duet needs someone on Voice 2");
    expect(
      partyEventText({
        code: "micBlocked",
        params: { memberId: 2, name: "Bo" },
      }),
    ).toBe("Bo's mic is blocked");
  });

  it("turns Queue refusals into text", () => {
    expect(
      userMessageText({ code: "tooManyPlayers", params: { max: 4 } }),
    ).toBe("At most 4 Players can sing a Song");
    expect(userMessageText({ code: "songPreparing" })).toBe(
      "That Song is still being prepared. Try again in a moment",
    );
  });

  it("turns join refusals into the Phone's text", () => {
    expect(userMessageText({ code: "joinCodeWrong" })).toBe(
      "That code is not on the Stage",
    );
    expect(userMessageText({ code: "partyFull" })).toBe("Party is full");
    expect(userMessageText({ code: "notInParty" })).toBe(
      "Join the Party first",
    );
    expect(
      userMessageText({ code: "nameTakenTonight", params: { memberId: 2 } }),
    ).toBe("Someone already has that name tonight");
    expect(userMessageText({ code: "colourTaken" })).toBe(
      "Someone else has that colour tonight",
    );
    expect(userMessageText({ code: "memberNotFound" })).toBe(
      "That person is no longer in the Party",
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
    | { code: "requestMovedUp"; params: { actor: string; song: string } }
    | { code: "backOnMic"; params: { actor: string } }
    | { code: "memberLeft"; params: { actor: string; colour: PaletteKey } };

  const toastText = byCode<ToastEvent>({
    requestMovedUp: ({ params }) => t("toast.requestMovedUp", params),
    backOnMic: ({ params }) => t("toast.backOnMic", params),
    memberLeft: ({ params }) =>
      t("toast.memberLeft", {
        actor: params.actor,
        colour: colourName(params.colour),
      }),
  });

  it("renders an event with an actor and a Song through t()", () => {
    expect(
      toastText({
        code: "requestMovedUp",
        params: { actor: "Bo", song: "Africa" },
      }),
    ).toBe("Bo moved Africa up");
    expect(toastText({ code: "backOnMic", params: { actor: "Mia" } })).toBe(
      "Mia is back on the mic",
    );
  });

  it("names a colour parameter by its palette display name", () => {
    expect(
      toastText({
        code: "memberLeft",
        params: { actor: "Lukas", colour: "tangerine" },
      }),
    ).toBe("Lukas left the Party. Tangerine is free");
  });

  it("uses no generic colour word in any server text", () => {
    const generic =
      /\b(red|green|blue|yellow|orange|purple|pink|brown|black|white|grey|gray|violet|cyan|magenta)\b/i;
    const serverText = Object.entries(en).filter(([key]) =>
      /^(userMessage|partyEvent|toast)\./.test(key),
    );
    expect(serverText.length).toBeGreaterThan(0);
    const withGenericWord = serverText
      .filter(([, entry]) => generic.test(JSON.stringify(entry)))
      .map(([key]) => key);
    expect(withGenericWord).toEqual([]);
  });
});
