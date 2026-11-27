// The Stage's stacking order (#245) is defined once, in `layers.css`, and the
// Stage's code uses its tokens: no numbered `z-10`…`z-50` utility, which
// reads as a layer of its own.

import { describe, expect, it } from "vitest";

import indexCss from "../index.css?raw";
import layersCss from "./layers.css?raw";
import { themeDeclarations } from "./tokens";

const LAYERS = ["scene", "chrome", "menu", "overlay", "dialog", "toast"];

describe("the stacking order", () => {
  const declarations = themeDeclarations(layersCss);

  it("is the six layers, bottom to top", () => {
    expect([...declarations.keys()]).toEqual(
      LAYERS.map((layer) => `--z-index-${layer}`),
    );
    const values = [...declarations.values()].map(Number);
    expect(values.every(Number.isInteger)).toBe(true);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
  });

  it("is imported by the app's stylesheet", () => {
    expect(indexCss).toContain('@import "./theme/layers.css";');
  });
});

/** The Stage's code: its frame, scenes and overlays, and the dialogs over it. */
const STAGE_CODE = import.meta.glob<string>(
  [
    "../{stage,mics,calibration,avSync,stageOptions,pin}/**/*.{ts,tsx}",
    "../ui/Dialog.tsx",
    "!../**/*.test.{ts,tsx}",
  ],
  { query: "?raw", import: "default", eager: true },
);

describe("the Stage's layers", () => {
  it("use the tokens, not numbered z utilities", () => {
    expect(Object.keys(STAGE_CODE)).toEqual(
      expect.arrayContaining([
        "../stage/frame/StageFrame.tsx",
        "../ui/Dialog.tsx",
      ]),
    );
    const numbered: string[] = [];
    for (const [file, code] of Object.entries(STAGE_CODE)) {
      for (const match of code.matchAll(/(?<![\w-])-?z-\d+(?![\w-])/g)) {
        numbered.push(`${file}: ${match[0]}`);
      }
    }
    expect(numbered).toEqual([]);
  });
});
