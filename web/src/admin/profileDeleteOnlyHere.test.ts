import { describe, expect, it } from "vitest";

// v1 spec #48 and #45: deleting a Profile happens only in the Admin area's
// Profiles section. It is not on the Remote's tabs (the People tab) or the
// Stage's overlays (the People overlay), so no other code sends the delete.
const sources = import.meta.glob<string>(
  [
    "../**/*.{ts,tsx}",
    "!../**/*.test.{ts,tsx}",
    "!../**/*.typetest.ts",
    "!../admin/Profiles.tsx",
    "!../api/api.ts",
  ],
  { query: "?raw", import: "default", eager: true },
);

describe("deleting a Profile", () => {
  it("has the rest of the app to look at", () => {
    expect(Object.keys(sources).some((file) => file.includes("/phone/"))).toBe(
      true,
    );
    expect(Object.keys(sources).some((file) => file.includes("/stage/"))).toBe(
      true,
    );
  });

  it.each(Object.entries(sources))(
    "%s does not send the Profile delete",
    (_file, source) => {
      expect(source).not.toMatch(/DELETE \/api\/profiles/);
    },
  );
});
