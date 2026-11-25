// @vitest-environment node
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

import { noPollingSyntax, onlyTheWrapperFetches } from "./apiRules.js";

const linter = new Linter({ configType: "flat" });

/** The messages the app's API rules report for `code`. */
function problems(code: string) {
  return linter.verify(code, {
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-restricted-globals": ["error", ...onlyTheWrapperFetches.globals],
      "no-restricted-properties": [
        "error",
        ...onlyTheWrapperFetches.properties,
      ],
      "no-restricted-syntax": ["error", ...noPollingSyntax],
    },
  });
}

function reported(code: string) {
  const messages = problems(code);
  // A parse error is a broken sample, not a finding.
  expect(messages.filter((message) => message.fatal)).toEqual([]);
  return messages.map((message) => message.ruleId);
}

describe("only the typed wrapper calls fetch", () => {
  it.each([
    `api("GET /api/server-info");`,
    // A local binding named fetch is not the browser's.
    `function f(fetch) { return fetch(); }`,
    `window.location;`,
  ])("allows %s", (code) => {
    expect(reported(code)).toEqual([]);
  });

  it.each([
    [`fetch("/api/server-info");`, "no-restricted-globals"],
    [`const get = fetch;`, "no-restricted-globals"],
    [`window.fetch("/api/server-info");`, "no-restricted-properties"],
    [`globalThis.fetch("/api/server-info");`, "no-restricted-properties"],
    [`self.fetch("/api/server-info");`, "no-restricted-properties"],
  ])("refuses %s", (code, rule) => {
    expect(reported(code)).toEqual([rule]);
  });
});

describe("nothing polls", () => {
  it.each([
    `useQuery({ queryKey: ["a"], queryFn });`,
    // Refetching on a change notice is how screens stay current.
    `store.onChanged("serverInfo", () => client.invalidateQueries({ queryKey }));`,
    // Timers that do not refetch are fine.
    `setTimeout(() => setOpen(false), 3000);`,
  ])("allows %s", (code) => {
    expect(reported(code)).toEqual([]);
  });

  it.each([
    `useQuery({ queryKey: ["a"], queryFn, refetchInterval: 1000 });`,
    `new QueryClient({ defaultOptions: { queries: { refetchInterval: 5000 } } });`,
    `useQuery({ queryKey, queryFn, refetchIntervalInBackground: true });`,
    `const { refetchInterval } = options;`,
    `setInterval(() => { void query.refetch(); }, 1000);`,
    `setTimeout(() => client.invalidateQueries({ queryKey }), 500);`,
    `window.setInterval(() => client.refetchQueries(), 1000);`,
    `setInterval(refetch, 1000);`,
    `setInterval(query.refetch, 1000);`,
  ])("refuses %s", (code) => {
    expect(reported(code)).toEqual(["no-restricted-syntax"]);
  });
});
