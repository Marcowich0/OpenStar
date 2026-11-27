// @vitest-environment node

// The Stage's stacking order (#245) is defined once, in `layers.css`, and the
// Stage's code uses its tokens: no numbered `z-10`…`z-50` utility, which
// reads as a layer of its own.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
    const indexCss = readFileSync(
      path.join(import.meta.dirname, "../index.css"),
      "utf8",
    );
    expect(indexCss).toContain('@import "./theme/layers.css";');
  });
});

const srcDir = path.join(import.meta.dirname, "..");

/** The Stage's code: its frame, scenes and overlays, and the dialogs over it. */
const STAGE_CODE = [
  "stage",
  "mics",
  "calibration",
  "avSync",
  "stageOptions",
  "pin",
  "ui/Dialog.tsx",
];

function sourceFiles(relative: string): string[] {
  const full = path.join(srcDir, relative);
  if (full.endsWith(".tsx") || full.endsWith(".ts")) return [relative];
  return readdirSync(full, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => path.join(relative, file));
}

describe("the Stage's layers", () => {
  it("use the tokens, not numbered z utilities", () => {
    const numbered: string[] = [];
    for (const file of STAGE_CODE.flatMap(sourceFiles)) {
      const code = readFileSync(path.join(srcDir, file), "utf8");
      for (const match of code.matchAll(/(?<![\w-])-?z-\d+(?![\w-])/g)) {
        numbered.push(`${file}: ${match[0]}`);
      }
    }
    expect(numbered).toEqual([]);
  });
});
