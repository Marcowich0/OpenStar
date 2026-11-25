import { describe, expect, it } from "vitest";

import { t } from "./t";
import {
  apiErrorText,
  byCode,
  libraryReadOnlyText,
  txtRejectionText,
  txtWarningText,
  userMessageText,
} from "./serverText";

describe("server texts", () => {
  it("turns a UserMessage code and its parameters into text", () => {
    expect(
      userMessageText({
        code: "placeholderTooLong",
        params: { maxLength: 1000 },
      }),
    ).toBe("The text can be at most 1,000 characters long");
    expect(userMessageText({ code: "serverError" })).toBe(
      "Something went wrong on the server",
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
