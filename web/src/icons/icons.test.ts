// The icon names, the SVG files and the custom properties in `icons.css` stay
// in step, so every named icon is in the build.

import { describe, expect, it } from "vitest";

import { ICON_NAMES, iconVar } from "./icons";

// The files as text (`?raw` CSS is processed: see `test.css` in vite.config.ts).
const files = import.meta.glob<string>(["./*.svg", "./icons.css"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("interface icons", () => {
  it("are one SVG file per name", () => {
    const svgs = Object.keys(files)
      .filter((file) => file.endsWith(".svg"))
      .map((file) => file.slice(2, -4))
      .sort();
    expect(svgs).toEqual([...ICON_NAMES].sort());
  });

  it("each have a custom property pointing at their file", () => {
    const css = files["./icons.css"] ?? "";
    for (const name of ICON_NAMES) {
      expect(css).toContain(`--icon-${name}: url("./${name}.svg");`);
    }
  });

  it("are referenced by custom property", () => {
    expect(iconVar("lock")).toBe("var(--icon-lock)");
  });
});
