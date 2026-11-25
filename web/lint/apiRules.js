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

/**
 * No query refetches on a timer: options for `no-restricted-syntax`. It
 * refuses TanStack Query's `refetchInterval` options and any refetch or
 * invalidation inside (or handed to) `setInterval` / `setTimeout`.
 */
export const noPollingSyntax = [
  {
    // The value of a shorthand property is the same word again: report it once.
    selector: String.raw`Identifier[name=/^refetchInterval/]:not(Property[shorthand=true] > Identifier.value)`,
    message: POLLING_MESSAGE,
  },
  ...TIMER_CALL.flatMap((timer) => [
    {
      selector: `${timer} CallExpression[callee.property.name=${REFETCH}]`,
      message: POLLING_MESSAGE,
    },
    {
      selector: `${timer} CallExpression[callee.name=${REFETCH}]`,
      message: POLLING_MESSAGE,
    },
    {
      selector: `${timer} > Identifier.arguments[name=${REFETCH}]`,
      message: POLLING_MESSAGE,
    },
    {
      selector: `${timer} > MemberExpression.arguments[property.name=${REFETCH}]`,
      message: POLLING_MESSAGE,
    },
  ]),
];
