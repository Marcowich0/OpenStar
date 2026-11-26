import { describe, expect, it } from "vitest";

// The guard audit (#224, v1 spec #45): no guarded action is reachable from
// the Remote's four tabs (Songs, Queue, Stage, People) or from the Stage's
// S, Q and P overlays. Every module those screens import, directly or
// through other modules, is read as text: none may call a guarded endpoint
// or use the guarded-action flow (`guarded/`), which is what opens the Admin
// PIN pad. Guarded actions live in the Admin area and, for Forget a Mic
// bridge, on the Stage's Mics screen.

/**
 * Every guarded endpoint, as `endpoints.rs` classifies it.
 * `crates/server/tests/guard.rs` fails when this list is not exactly the
 * server's.
 */
const GUARDED = [
  "POST /api/unlock/heartbeat",
  "DELETE /api/profiles/{id}",
  "DELETE /api/songs/{id}",
  "POST /api/songs/{id}/auto-fit",
  "POST /api/songs/{id}/timing",
  "POST /api/songs/{id}/restore-original",
  "POST /api/library/trash/{id}/restore",
  "DELETE /api/mic-bridges/{id}",
  "POST /api/downloads",
];

/** The screens that must offer no guarded action. */
const ROOTS = {
  "the Remote's four tabs": "./phone/Remote.tsx",
  "the Stage's S overlay": "./stage/overlays/SongsOverlay.tsx",
  "the Stage's Q overlay": "./stage/overlays/QueueOverlay.tsx",
  "the Stage's P overlay": "./stage/overlays/PeopleOverlay.tsx",
};

const sources = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./generated/**"],
  { query: "?raw", import: "default", eager: true },
);

function source(file: string): string {
  const text = sources[file];
  if (text === undefined) throw new Error(`no source ${file}`);
  return text;
}

/** `from "<relative>"` and `import("<relative>")` targets, resolved to source keys. */
function imports(file: string, source: string): string[] {
  const dir = file.split("/").slice(0, -1);
  const found: string[] = [];
  for (const match of source.matchAll(
    /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    const parts = [...dir];
    for (const part of (match[1] ?? "").split("/")) {
      if (part === "..") parts.pop();
      else if (part !== ".") parts.push(part);
    }
    const base = parts.join("/");
    const key = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
      (candidate) => candidate in sources,
    );
    if (key !== undefined) found.push(key);
  }
  return found;
}

function reachableFrom(root: string): string[] {
  const seen = new Set<string>([root]);
  const todo = [root];
  for (let file = todo.pop(); file !== undefined; file = todo.pop()) {
    for (const next of imports(file, source(file))) {
      if (!seen.has(next)) {
        seen.add(next);
        todo.push(next);
      }
    }
  }
  return [...seen];
}

function calls(source: string, endpoint: string): boolean {
  return new RegExp(`\\(\\s*"${endpoint.replace(/[{}/]/g, "\\$&")}"`).test(
    source,
  );
}

/** What in `source` would start a guarded action. */
function guardedUses(source: string): string[] {
  // A call names its endpoint as its first argument; `api/api.ts` names
  // every endpoint as a type key, which calls nothing.
  const uses = GUARDED.filter((endpoint) => calls(source, endpoint));
  if (
    /from\s+["'][./]*guarded\/(useGuardedAction|GuardedButton)["']/.test(source)
  ) {
    uses.push("the guarded-action flow");
  }
  if (/from\s+["'][./]*mics\/ForgetBridge["']/.test(source)) {
    uses.push("Forget a Mic bridge");
  }
  return uses;
}

describe("the guard audit", () => {
  it("finds the guarded endpoints where the Admin area and the Mics screen call them", () => {
    const callers = GUARDED.filter((endpoint) =>
      Object.values(sources).some((source) => calls(source, endpoint)),
    );
    expect(callers).toEqual(GUARDED);
  });

  it.each(Object.entries(ROOTS))(
    "offers no guarded action from %s",
    (_screen, root) => {
      expect(root in sources).toBe(true);
      const reachable = reachableFrom(root);
      expect(reachable.length).toBeGreaterThan(5);
      const offenders = reachable
        .map((file) => [file, guardedUses(source(file))] as const)
        .filter(([, uses]) => uses.length > 0);
      expect(offenders).toEqual([]);
    },
  );

  it("would see a guarded action that one of them reached", () => {
    expect(reachableFrom("./mics/MicsScreen.tsx")).toContain(
      "./mics/ForgetBridge.tsx",
    );
    expect(guardedUses(source("./mics/ForgetBridge.tsx"))).toEqual([
      "DELETE /api/mic-bridges/{id}",
      "the guarded-action flow",
    ]);
  });
});
