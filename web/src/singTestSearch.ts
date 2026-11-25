// The search of `/stage/sing-test`, the test-only entry that renders the sing
// screen from synthetic state at a frozen Song time for the painter
// screenshots (#58). It lives outside `stage/` because the router imports it
// statically; the screen itself is in `stage/sing/`.

/** The synthetic sing screens: 1, 4 and 8 Players, and a duet. */
export const SING_TEST_CASES = ["one", "four", "eight", "duet"] as const;
export type SingTestCase = (typeof SING_TEST_CASES)[number];

export interface SingTestSearch {
  case: SingTestCase;
  /** The frozen Song time to draw, seconds. */
  t: number;
}

const DEFAULT: SingTestSearch = { case: "one", t: 6 };

function isCase(value: unknown): value is SingTestCase {
  return (SING_TEST_CASES as readonly unknown[]).includes(value);
}

export function validateSingTestSearch(
  search: Record<string, unknown>,
): SingTestSearch {
  return {
    case: isCase(search.case) ? search.case : DEFAULT.case,
    t:
      typeof search.t === "number" && Number.isFinite(search.t)
        ? search.t
        : DEFAULT.t,
  };
}
