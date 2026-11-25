// Options for ESLint core rules that keep HTTP in one place and stop polling.
// `eslint.config.js` applies them; `apiRules.test.ts` tests them.

const FETCH_MESSAGE =
  "Call the HTTP+JSON API through `api()` from src/api/api.ts, the one typed fetch wrapper.";

/**
 * Only `src/api/api.ts` may call `fetch`: options for `no-restricted-globals`
 * and `no-restricted-properties`.
 */
export const onlyTheWrapperFetches = {
  globals: [{ name: "fetch", message: FETCH_MESSAGE }],
  properties: ["window", "globalThis", "self"].map((object) => ({
    object,
    property: "fetch",
    message: FETCH_MESSAGE,
  })),
};

const POLLING_MESSAGE =
  "Nothing polls: the server pushes a change notice over the WebSocket and src/api/changeNotices.ts invalidates the matching queries.";

const TIMER = String.raw`/^set(Interval|Timeout)$/`;
const REFETCH = String.raw`/^(refetch|refetchQueries|invalidateQueries|resetQueries)$/`;
const TIMER_CALL = [
  `CallExpression[callee.name=${TIMER}]`,
  `CallExpression[callee.property.name=${TIMER}]`,
];

const POLLING_SELECTORS = [
  // The value of a shorthand property is the same word again: report it once.
  String.raw`Identifier[name=/^refetchInterval/]:not(Property[shorthand=true] > Identifier.value)`,
  ...TIMER_CALL.flatMap((timer) => [
    `${timer} CallExpression[callee.property.name=${REFETCH}]`,
    `${timer} CallExpression[callee.name=${REFETCH}]`,
    `${timer} > Identifier.arguments[name=${REFETCH}]`,
    `${timer} > MemberExpression.arguments[property.name=${REFETCH}]`,
  ]),
];

/**
 * ESLint rule `api/no-polling`: no query refetches on a timer. It refuses
 * TanStack Query's `refetchInterval` options and any refetch or invalidation
 * inside (or handed to) `setInterval` / `setTimeout`.
 *
 * @type {import("eslint").Rule.RuleModule}
 */
export const noPolling = {
  meta: {
    type: "problem",
    docs: { description: "Refuse timer-driven refetches of queries" },
    messages: { polling: POLLING_MESSAGE },
    schema: [],
  },
  create(context) {
    /** @type {import("eslint").Rule.RuleListener} */
    const listener = {};
    for (const selector of POLLING_SELECTORS) {
      listener[selector] = (/** @type {import("eslint").Rule.Node} */ node) => {
        context.report({ node, messageId: "polling" });
      };
    }
    return listener;
  },
};

/** The plugin `eslint.config.js` registers as `api`. */
export const apiPlugin = { rules: { "no-polling": noPolling } };
