// @vitest-environment node

// No colour literal outside the token definitions: component and draw-list
// source names colours by palette key or token. TypeScript is checked by an
// ESLint rule (so the editor shows it); stylesheets by `cssColourLiterals`,
// which `just check` runs over every stylesheet in `src/` here.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ESLint, Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

import {
  COLOUR_LITERAL_ALLOWED,
  colourLiteralRule,
  cssColourLiterals,
} from "./colourLiterals.js";

const webDir = path.join(import.meta.dirname, "..");

function lint(code: string): string[] {
  const linter = new Linter();
  return linter
    .verify(
      code,
      [
        {
          files: ["**/*.tsx"],
          languageOptions: { parser: tseslint.parser },
          rules: { "no-restricted-syntax": colourLiteralRule },
        },
      ],
      "Component.tsx",
    )
    .map((message) => message.message);
}

describe("the ESLint colour-literal rule", () => {
  it.each([
    ['const c = "#FF4B5C";'],
    ['const c = "#fff";'],
    ['const c = "#2b2d42cc";'],
    ['const c = "rgb(1, 2, 3)";'],
    ['const c = "rgba(43,45,66,.4)";'],
    ['const c = "hsl(10 50% 50%)";'],
    ["const c = `0 8px 0 rgba(0,0,0,${0.2})`;"],
    ['export const A = () => <svg fill="#2EA8FF" />;'],
  ])("flags %s", (code) => {
    expect(lint(code)).toHaveLength(1);
  });

  it.each([
    ['const c = "cherry";'],
    ['const c = "var(--color-ink)";'],
    ['const id = "#root";'],
    ["// see #107 and #55\nconst n = 1;"],
    ['const issue = "#1234567";'],
  ])("allows %s", (code) => {
    expect(lint(code)).toEqual([]);
  });

  it("is on for source files and off only for the token definitions", async () => {
    const eslint = new ESLint({ cwd: webDir });
    const ruleFor = async (file: string) =>
      ((await eslint.calculateConfigForFile(file)) as Linter.Config).rules?.[
        "no-restricted-syntax"
      ];

    expect(await ruleFor("src/stage/StageScreen.tsx")).toEqual(
      colourLiteralRule,
    );
    expect(await ruleFor("src/ui/Dialog.tsx")).toEqual(colourLiteralRule);
    for (const file of COLOUR_LITERAL_ALLOWED.filter((f) =>
      f.endsWith(".ts"),
    )) {
      expect(((await ruleFor(file)) as unknown[])[0]).toBe(0);
    }
  });
});

describe("stylesheet colour literals", () => {
  it("finds hex, rgb() and hsl() values, but not in comments", () => {
    const css = [
      "/* the old ink was #2b2d42 */",
      ".a { color: #2b2d42; }",
      ".b { background: rgba(0, 0, 0, 0.4); }",
      "#root { color: var(--color-ink); }",
    ].join("\n");
    expect(cssColourLiterals(css)).toEqual(["#2b2d42", "rgba("]);
  });

  it("finds none in any stylesheet outside the token definitions", () => {
    const stylesheets = readdirSync(path.join(webDir, "src"), {
      recursive: true,
      encoding: "utf8",
    })
      .filter((file) => file.endsWith(".css"))
      .map((file) => path.join("src", file))
      .filter((file) => !COLOUR_LITERAL_ALLOWED.includes(file));

    expect(stylesheets).not.toEqual([]);
    const found = stylesheets.flatMap((file) =>
      cssColourLiterals(readFileSync(path.join(webDir, file), "utf8")).map(
        (literal) => `${file}: ${literal}`,
      ),
    );
    expect(found).toEqual([]);
  });
});
