// @vitest-environment node

// The build-output check that code is split by route: a Phone downloads only
// the Phone code. It builds the app in memory and walks the chunk graph a
// browser loads for `/`: the entry chunk, the Phone route's lazy chunk, and
// everything those import statically.
//
// A module belongs only to the Stage or only to the Admin area when it lives
// under `src/stage/` or `src/admin/`; code the routes share lives elsewhere.

import path from "node:path";

import { build, type Rolldown } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

const webDir = import.meta.dirname;
const src = path.join(webDir, "src");

type OutputChunk = Rolldown.OutputChunk;

let chunks: OutputChunk[];

beforeAll(async () => {
  const output = await build({
    root: webDir,
    configFile: path.join(webDir, "vite.config.ts"),
    logLevel: "silent",
    build: { write: false },
  });
  if (!("output" in output))
    throw new Error("expected a single in-memory build output");
  chunks = output.output.filter(
    (file): file is OutputChunk => file.type === "chunk",
  );
}, 120_000);

function chunkOf(sourceFile: string): OutputChunk {
  const id = path.join(src, sourceFile);
  const chunk = chunks.find((c) => c.moduleIds.includes(id));
  if (!chunk) throw new Error(`no chunk contains ${sourceFile}`);
  return chunk;
}

/** `roots` and every chunk they import statically, as a browser loads them. */
function staticGraph(roots: OutputChunk[]): OutputChunk[] {
  const seen = new Map<string, OutputChunk>();
  const visit = (chunk: OutputChunk) => {
    if (seen.has(chunk.fileName)) return;
    seen.set(chunk.fileName, chunk);
    for (const name of chunk.imports) {
      const next = chunks.find((c) => c.fileName === name);
      if (next) visit(next);
    }
  };
  roots.forEach(visit);
  return [...seen.values()];
}

function modulesUnder(graph: OutputChunk[], folder: string): string[] {
  const prefix = path.join(src, folder) + path.sep;
  return graph
    .flatMap((c) => c.moduleIds)
    .filter((id) => id.startsWith(prefix));
}

describe("code split by route", () => {
  it("loads no Stage or Admin area module for the Phone route `/`", () => {
    const entry = chunks.filter((c) => c.isEntry);
    const phone = staticGraph([...entry, chunkOf("phone/PhoneScreen.tsx")]);

    expect(modulesUnder(phone, "phone")).not.toEqual([]);
    expect(modulesUnder(phone, "stage")).toEqual([]);
    expect(modulesUnder(phone, "admin")).toEqual([]);
  });

  it("loads the Stage and the Admin area in chunks of their own", () => {
    expect(
      modulesUnder(staticGraph([chunkOf("stage/StageScreen.tsx")]), "stage"),
    ).not.toEqual([]);
    expect(
      modulesUnder(staticGraph([chunkOf("admin/AdminArea.tsx")]), "admin"),
    ).not.toEqual([]);
    expect(chunkOf("stage/StageScreen.tsx").isEntry).toBe(false);
    expect(chunkOf("admin/AdminArea.tsx").isEntry).toBe(false);
  });
});

describe("the production build", () => {
  // The painter screenshot page (`sing-test.html`, #203) is built only by
  // `just e2e` / `just update-screenshots`, never into the binary.
  it("contains no module of the test-only screenshot page", () => {
    const ids = chunks.flatMap((c) => c.moduleIds);
    expect(ids.filter((id) => id.includes("SingTestScreen"))).toEqual([]);
    expect(
      ids.filter((id) => id.startsWith(path.join(src, "singTest"))),
    ).toEqual([]);
  });
});
