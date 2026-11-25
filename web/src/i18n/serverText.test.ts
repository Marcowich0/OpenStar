import { describe, expect, it } from "vitest";

import { colourName } from "./colourNames";
import { en } from "./en";
import type { PaletteKey } from "./paletteKeys";
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
    | { code: "backOnMic"; params: { actor: string } }
    | { code: "memberLeft"; params: { actor: string; colour: PaletteKey } };

  const toastText = byCode<ToastEvent>({
    songMovedUp: ({ params }) => t("toast.songMovedUp", params),
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
        code: "songMovedUp",
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
