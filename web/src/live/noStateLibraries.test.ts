import { describe, expect, it } from "vitest";

import manifestText from "../../package.json?raw";

// Live state is one store and one reducer of our own (#113); the spec rules
// out Redux and Zustand.
describe("package.json", () => {
  it("depends on neither Redux nor Zustand", () => {
    const manifest = JSON.parse(manifestText) as Record<
      string,
      Record<string, string> | undefined
    >;
    const names = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ].flatMap((field) => Object.keys(manifest[field] ?? {}));
    const banned = names.filter((name) => /redux|zustand/i.test(name));
    expect(names).toContain("react");
    expect(banned).toEqual([]);
  });
});
