import { describe, expect, it } from "vitest";

import { clearSelection, extendSelection, selectLine } from "./selection";

describe("a Line selection", () => {
  it("is one Line after a click", () => {
    expect(selectLine({ voice: 0, line: 3 })).toEqual({
      voice: 0,
      anchor: 3,
      first: 3,
      last: 3,
    });
  });

  it("extends to a contiguous range from the clicked Line, either way", () => {
    const one = selectLine({ voice: 0, line: 3 });
    expect(extendSelection(one, { voice: 0, line: 6 })).toEqual({
      voice: 0,
      anchor: 3,
      first: 3,
      last: 6,
    });
    expect(extendSelection(one, { voice: 0, line: 1 })).toEqual({
      voice: 0,
      anchor: 3,
      first: 1,
      last: 3,
    });
  });

  it("re-extends from the Line first clicked, not from the far end", () => {
    const range = extendSelection(selectLine({ voice: 0, line: 3 }), {
      voice: 0,
      line: 6,
    });
    expect(extendSelection(range, { voice: 0, line: 4 })).toEqual({
      voice: 0,
      anchor: 3,
      first: 3,
      last: 4,
    });
  });

  it("stays in one Voice: extending into another Voice selects that Line", () => {
    const one = selectLine({ voice: 0, line: 3 });
    expect(extendSelection(one, { voice: 1, line: 5 })).toEqual({
      voice: 1,
      anchor: 5,
      first: 5,
      last: 5,
    });
  });

  it("extending with nothing selected selects the Line", () => {
    expect(extendSelection(null, { voice: 0, line: 2 })).toEqual({
      voice: 0,
      anchor: 2,
      first: 2,
      last: 2,
    });
  });

  it("is cleared by Esc", () => {
    expect(clearSelection()).toBeNull();
  });
});
