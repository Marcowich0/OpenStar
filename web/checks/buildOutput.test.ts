// @vitest-environment node

// The build-output check that OpenStar serves every font and icon itself: the
// deployment is LAN-only, so the built HTML, CSS and JS must not reference an
// external host (a CDN, Google Fonts), and the Fredoka files and SVG icons
// must be part of the build. Builds the app in memory, like `codeSplit.test.ts`.

import path from "node:path";

import { build, type Rolldown } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

import { externalHosts } from "./externalHosts.js";

const webDir = path.join(import.meta.dirname, "..");

let files: (Rolldown.OutputChunk | Rolldown.OutputAsset)[];

beforeAll(async () => {
  const output = await build({
    root: webDir,
    configFile: path.join(webDir, "vite.config.ts"),
    logLevel: "silent",
    // Vitest sets NODE_ENV=test, which would build React's development code
    // (with links in its warnings); check what ships.
    mode: "production",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false },
  });
  if (!("output" in output))
    throw new Error("expected a single in-memory build output");
  files = output.output;
}, 120_000);

function text(file: Rolldown.OutputChunk | Rolldown.OutputAsset): string {
  if (file.type === "chunk") return file.code;
  return typeof file.source === "string"
    ? file.source
    : new TextDecoder().decode(file.source);
}

describe("externalHosts", () => {
  it.each([
    ['<link href="https://fonts.googleapis.com/css2?family=Fredoka">'],
    ["@import url(//fonts.googleapis.com/css);"],
    ['src: url("https://cdn.jsdelivr.net/x.woff2")'],
    ['import("https://unpkg.com/react")'],
    ['fetch("http://example.com/api")'],
  ])("finds the host in %s", (code) => {
    expect(externalHosts(code)).toHaveLength(1);
  });

  it.each([
    ['<svg xmlns="http://www.w3.org/2000/svg">'],
    ['"https://react.dev/errors/" + code'],
    ['fetch("/api/info")'],
    ["src: url(/assets/fredoka-latin-500-normal.woff2)"],
    ["a = b // c"],
  ])("ignores %s", (code) => {
    expect(externalHosts(code)).toEqual([]);
  });
});

describe("the build output", () => {
  it("references no external host from its HTML, CSS or JS", () => {
    const found = files
      .filter((file) => /\.(html|css|js)$/.test(file.fileName))
      .flatMap((file) =>
        externalHosts(text(file)).map((host) => `${file.fileName}: ${host}`),
      );
    expect(found).toEqual([]);
  });

  it("puts the theme tokens on :root, used by a utility or not", () => {
    const css = files
      .filter((file) => file.fileName.endsWith(".css"))
      .map(text)
      .join("\n");
    const root = /:root[^{]*\{([^}]*--color-party-cherry[^}]*)\}/.exec(
      css,
    )?.[1];
    for (const token of [
      "--color-party-cherry",
      "--color-party-tangerine",
      "--color-golden-bottom",
      "--radius-card-lg",
      "--shadow-ledge-sm",
      "--ease-spring",
      "--font-sans",
    ]) {
      expect(root).toContain(`${token}:`);
    }
  });

  it("holds the Fredoka font files for weights 500 to 700", () => {
    const fonts = files
      .map((file) => file.fileName)
      .filter((name) => /fredoka-latin-\d00-normal.*\.woff2$/.test(name));
    for (const weight of [500, 600, 700]) {
      expect(fonts.some((name) => name.includes(`-${String(weight)}-`))).toBe(
        true,
      );
    }
    expect(fonts.some((name) => /-(300|400)-/.test(name))).toBe(false);
  });

  it("serves the fonts from its own CSS", () => {
    const css = files.filter((file) => file.fileName.endsWith(".css"));
    expect(css.map(text).join("\n")).toMatch(
      /font-family:\s*"?Fredoka"?[\s\S]*?url\(\/assets\/fredoka-latin-700-normal[^)]*\.woff2\)/,
    );
  });

  it("holds the SVG icons as files", () => {
    const icons = files
      .map((file) => file.fileName)
      .filter((name) => name.endsWith(".svg"));
    expect(icons.some((name) => name.includes("close"))).toBe(true);
  });
});
