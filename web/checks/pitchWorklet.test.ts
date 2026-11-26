// @vitest-environment node

// The build-output check for the pitch-detection worklet (ticket #105): the
// production build emits the worklet as one file of its own, from the one
// shared loader (`src/pitch/worklet/`, outside every route's folder), with the
// `detector-wasm` module bundled beside it as a build asset. Nothing is
// fetched from another host (`buildOutput.test.ts` checks every JS file,
// the worklet's included).

import { readFileSync } from "node:fs";
import path from "node:path";

import { build, type Rolldown } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

const webDir = path.join(import.meta.dirname, "..");
const src = path.join(webDir, "src");
const LOADER = path.join(src, "pitch/worklet/pitchWorklet.ts");

type OutputFile = Rolldown.OutputChunk | Rolldown.OutputAsset;
type OutputChunk = Rolldown.OutputChunk;

let files: OutputFile[];

beforeAll(async () => {
  const output = await build({
    root: webDir,
    configFile: path.join(webDir, "vite.config.ts"),
    logLevel: "silent",
    mode: "production",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false },
  });
  if (!("output" in output))
    throw new Error("expected a single in-memory build output");
  files = output.output;
}, 120_000);

function text(file: OutputFile): string {
  if (file.type === "chunk") return file.code;
  return typeof file.source === "string"
    ? file.source
    : new TextDecoder().decode(file.source);
}

function chunks(): OutputChunk[] {
  return files.filter((f): f is OutputChunk => f.type === "chunk");
}

function worklets(): OutputFile[] {
  return files.filter((f) =>
    /^assets\/pitchProcessor-[\w-]+\.js$/.test(f.fileName),
  );
}

function wasmFiles(): OutputFile[] {
  return files.filter((f) => f.fileName.endsWith(".wasm"));
}

/** `root` and every chunk it imports, statically or lazily: all a route can load. */
function reachable(root: OutputChunk): OutputChunk[] {
  const seen = new Map<string, OutputChunk>();
  const visit = (chunk: OutputChunk) => {
    if (seen.has(chunk.fileName)) return;
    seen.set(chunk.fileName, chunk);
    for (const name of [...chunk.imports, ...chunk.dynamicImports]) {
      const next = chunks().find((c) => c.fileName === name);
      if (next) visit(next);
    }
  };
  visit(root);
  return [...seen.values()];
}

describe("the pitch worklet in the build", () => {
  it("is one file of its own that registers the processor and imports nothing", () => {
    expect(worklets()).toHaveLength(1);
    const [worklet] = worklets();
    if (!worklet) return;
    const code = text(worklet);
    expect(code).toContain("openstar-pitch");
    expect(code).toContain("registerProcessor");
    expect(code).not.toMatch(/\bimport\s*[({"'`]|\bimport\s+[\w{*]/);
    expect(code).not.toMatch(/\bfetch\(/);
  });

  it("bundles the detector-wasm module as a build asset, byte for byte", () => {
    expect(wasmFiles().map((f) => f.fileName)).toEqual([
      expect.stringMatching(
        /^assets\/openstar_detector-[\w-]+\.wasm$/,
      ) as string,
    ]);
    const [wasm] = wasmFiles();
    if (!wasm || wasm.type !== "asset") throw new Error("no wasm asset");
    const built = Buffer.from(wasm.source as Uint8Array);
    const source = readFileSync(
      path.join(webDir, "wasm/openstar_detector.wasm"),
    );
    expect(built.equals(source)).toBe(true);
  });

  it("loads both from the one shared loader, by same-origin paths", () => {
    const loaderChunks = chunks().filter((c) => c.moduleIds.includes(LOADER));
    expect(loaderChunks).toHaveLength(1);
    const [loader] = loaderChunks;
    if (!loader) return;
    for (const folder of ["phone", "stage", "admin"])
      expect(LOADER.startsWith(path.join(src, folder) + path.sep)).toBe(false);
    const [worklet] = worklets();
    const [wasm] = wasmFiles();
    // A same-origin path in a string literal, whatever quotes it uses.
    for (const file of [worklet, wasm]) {
      const name = (file?.fileName ?? "?").replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      expect(loader.code).toMatch(new RegExp(`[\`"']/${name}[\`"']`));
    }
  });

  it("is what the Stage route loads", () => {
    const stage = chunks().find((c) =>
      c.moduleIds.includes(path.join(src, "stage/StageScreen.tsx")),
    );
    if (!stage) throw new Error("no Stage chunk");
    expect(reachable(stage).some((c) => c.moduleIds.includes(LOADER))).toBe(
      true,
    );
  });
});
