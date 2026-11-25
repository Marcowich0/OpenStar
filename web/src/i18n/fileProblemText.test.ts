import { describe, expect, it } from "vitest";

import { fileProblemText } from "./serverText";

describe("fileProblemText", () => {
  it("renders media that could not be converted", () => {
    expect(
      fileProblemText({ code: "audioNotConverted", file: "A/clip.avi" }),
    ).toBe(
      "The audio A/clip.avi does not play on the Stage and could not be converted",
    );
    expect(
      fileProblemText({ code: "videoNotConverted", file: "A/clip.wmv" }),
    ).toBe(
      "The video A/clip.wmv does not play on the Stage and could not be converted, so the Song plays over its background",
    );
  });

  it("renders the other file problems", () => {
    expect(
      fileProblemText({
        code: "mediaNotFound",
        header: "VIDEO",
        reference: "v.mp4",
      }),
    ).toBe("#VIDEO names v.mp4, which is not found");
  });
});
