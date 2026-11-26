import { describe, expect, it } from "vitest";

import { isFormField } from "./formField";

describe("a key's target", () => {
  // jsdom has no `isContentEditable`, so editable text is not shown here.
  it("is a form field for any input, a textarea and a select", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    for (const field of [
      document.createElement("input"),
      checkbox,
      document.createElement("textarea"),
      document.createElement("select"),
    ])
      expect(isFormField(field)).toBe(true);
  });

  it("is no form field for a button, the page or nothing", () => {
    expect(isFormField(document.createElement("button"))).toBe(false);
    expect(isFormField(document.body)).toBe(false);
    expect(isFormField(window)).toBe(false);
    expect(isFormField(null)).toBe(false);
  });
});
