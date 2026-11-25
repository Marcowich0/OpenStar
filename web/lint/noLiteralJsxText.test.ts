// @vitest-environment node
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";

import { noLiteralJsxText } from "./noLiteralJsxText.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const literal = { messageId: "literal" } as const;

tester.run("no-literal-jsx-text", noLiteralJsxText, {
  valid: [
    // Text through t(), whatever its arguments.
    `<p>{t("join.enterCode")}</p>`,
    `<p>{t("join.code", { code: "0427" })}</p>`,
    `<p>{cond ? t("a") : t("b")}</p>`,
    // Values that are not text: data, numbers, whitespace between elements.
    `<p>{live.stage?.placeholder ?? ""}</p>`,
    `<p>{count}</p>`,
    `<nav>\n  <a />{" "}\n  <a />\n</nav>`,
    // Attributes that are not shown: ids, classes, routes, types.
    `<Link to="/admin/songs" className="x" data-testid="placeholder" />`,
    `<button type="submit" />`,
    // Text attributes through t().
    `<input aria-label={t("live.placeholderLabel")} />`,
  ],
  invalid: [
    { code: `<h1>Stage</h1>`, errors: [literal] },
    { code: `<p>WebSocket: {state}</p>`, errors: [literal] },
    { code: `<p>{"Enter the Join code"}</p>`, errors: [literal] },
    { code: "<p>{`Join code ${code}`}</p>", errors: [literal] },
    {
      code: `<p>{code === undefined ? "Enter the code" : t("a")}</p>`,
      errors: [literal],
    },
    { code: `<p>{failed && "Failed"}</p>`, errors: [literal] },
    { code: `<p>{"Server " + version}</p>`, errors: [literal] },
    { code: `<input aria-label="Placeholder" />`, errors: [literal] },
    { code: `<img alt={"A cover"} />`, errors: [literal] },
    {
      code: `<input placeholder="Name" title="Your name" />`,
      errors: [literal, literal],
    },
  ],
});
