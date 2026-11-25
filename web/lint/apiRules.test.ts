// @vitest-environment node
import path from "node:path";

import { ESLint, Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

import { apiPlugin, onlyTheWrapperFetches } from "./apiRules.js";

const linter = new Linter({ configType: "flat" });

/** The messages the app's API rules report for `code`. */
function problems(code: string) {
  return linter.verify(code, {
    languageOptions: { parser: tseslint.parser },
    plugins: { api: apiPlugin },
    rules: {
      "no-restricted-globals": ["error", ...onlyTheWrapperFetches.globals],
      "no-restricted-properties": [
        "error",
        ...onlyTheWrapperFetches.properties,
      ],
      "api/no-polling": "error",
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
    expect(reported(code)).toEqual(["api/no-polling"]);
  });
});

describe("the app's ESLint config", () => {
  const eslint = new ESLint({ cwd: path.join(import.meta.dirname, "..") });
  const rulesFor = async (file: string) =>
    ((await eslint.calculateConfigForFile(file)) as Linter.Config).rules ?? {};
  const severity = (setting: Linter.RuleEntry | undefined) =>
    Array.isArray(setting) ? setting[0] : setting;

  it("refuses fetch and polling in every source file but the wrapper", async () => {
    for (const file of [
      "src/phone/ServerStatus.tsx",
      "src/api/changeNotices.ts",
      "src/api/api.test.ts",
    ]) {
      const rules = await rulesFor(file);
      expect(severity(rules["no-restricted-globals"]), file).toBe(2);
      expect(severity(rules["no-restricted-properties"]), file).toBe(2);
      expect(severity(rules["api/no-polling"]), file).toBe(2);
    }

    const wrapper = await rulesFor("src/api/api.ts");
    expect(severity(wrapper["no-restricted-globals"])).toBe(0);
    expect(severity(wrapper["api/no-polling"])).toBe(2);
  });
});
