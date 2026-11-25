// ESLint rule `openstar/no-literal-jsx-text`: every word on screen comes from
// the catalogue through `t()` (`src/i18n/t.ts`), so JSX may not hold literal
// text. It reports:
// - JSX text with anything but whitespace (`<h1>Stage</h1>`);
// - a string or template literal with text, or a `+` with a string, in a JSX
//   child expression, also inside `? :`, `&&`, `||` and `??`;
// - the same in an attribute a person reads or hears (`aria-label`, `alt`,
//   `title`, `placeholder`, …).
// Calls are not looked into, so `t("key", { code: "0427" })` is fine, and so
// are attributes nobody reads (`className`, `to`, `data-testid`, `type`).

/** Attributes whose value is shown or read aloud. */
const TEXT_ATTRIBUTES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "label",
  "placeholder",
  "title",
]);

/**
 * An AST node as this rule reads it. ESTree has no JSX types and `@types/estree`
 * is not a dependency, so every field is `unknown` and narrowed where it is read.
 * @typedef {{ type: string, [field: string]: unknown }} AnyNode
 */

/**
 * @param {unknown} value
 * @returns {value is AnyNode}
 */
function isNode(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

/**
 * @param {unknown} text
 * @returns {boolean}
 */
function hasText(text) {
  return typeof text === "string" && text.trim() !== "";
}

/**
 * The parts of an expression that would put literal text on screen.
 * @param {unknown} node
 * @returns {AnyNode[]}
 */
function literalText(node) {
  if (!isNode(node)) return [];
  switch (node.type) {
    case "Literal":
      return hasText(node.value) ? [node] : [];
    case "TemplateLiteral": {
      const quasis = Array.isArray(node.quasis) ? node.quasis : [];
      return quasis.some(
        (quasi) => isNode(quasi) && hasText(rawText(quasi.value)),
      )
        ? [node]
        : [];
    }
    case "ConditionalExpression":
      return [...literalText(node.consequent), ...literalText(node.alternate)];
    case "LogicalExpression":
      return [...literalText(node.left), ...literalText(node.right)];
    case "BinaryExpression": {
      if (node.operator !== "+") return [];
      const parts = [...literalText(node.left), ...literalText(node.right)];
      return parts.length > 0 ? [node] : [];
    }
    default:
      return [];
  }
}

/**
 * A template element's raw text (`{ raw, cooked }`).
 * @param {unknown} value
 * @returns {unknown}
 */
function rawText(value) {
  return typeof value === "object" && value !== null && "raw" in value
    ? value.raw
    : undefined;
}

/**
 * The expression in a JSX expression container, unless it is empty (`{}`).
 * @param {AnyNode} container
 * @returns {unknown}
 */
function containedExpression(container) {
  const expression = container.expression;
  return isNode(expression) && expression.type !== "JSXEmptyExpression"
    ? expression
    : undefined;
}

/** @type {import("eslint").Rule.RuleModule} */
export const noLiteralJsxText = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow literal text in JSX; on-screen text goes through t() and the catalogue",
    },
    messages: {
      literal:
        "Text on screen comes from the catalogue: add a key to src/i18n/en.ts and use t().",
    },
    schema: [],
  },
  create(context) {
    /** @param {AnyNode} node */
    const report = (node) => {
      // Every node this rule reports came from the parser, with its location.
      context.report({
        node: /** @type {import("eslint").Rule.Node} */ (
          /** @type {unknown} */ (node)
        ),
        messageId: "literal",
      });
    };
    /** @param {unknown} expression */
    const check = (expression) => {
      literalText(expression).forEach(report);
    };

    return {
      /** @param {unknown} node */
      JSXText(node) {
        if (isNode(node) && hasText(node.value)) report(node);
      },
      /** @param {unknown} node */
      JSXExpressionContainer(node) {
        if (!isNode(node)) return;
        // Attribute values are checked, for text attributes only, below.
        if (isNode(node.parent) && node.parent.type === "JSXAttribute") return;
        check(containedExpression(node));
      },
      /** @param {unknown} node */
      JSXAttribute(node) {
        if (!isNode(node) || !isNode(node.name)) return;
        const name = node.name.name;
        if (typeof name !== "string" || !TEXT_ATTRIBUTES.has(name)) return;
        const value = node.value;
        if (!isNode(value)) return;
        if (value.type === "Literal") check(value);
        else if (value.type === "JSXExpressionContainer") {
          check(containedExpression(value));
        }
      },
    };
  },
};

/** The `openstar` ESLint plugin: OpenStar's own rules. */
export const openstarPlugin = {
  rules: { "no-literal-jsx-text": noLiteralJsxText },
};
