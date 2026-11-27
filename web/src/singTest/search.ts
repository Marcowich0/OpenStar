// The search of `sing-test.html`, the test-only screenshot page that renders
// the sing screen from synthetic state at a frozen Song time (#203). The page
// is a Vite entry of its own, built only for `just e2e` and
// `just update-screenshots`, never into the binary.

import type { LyricSize } from "../generated/LyricSize";

/** The synthetic sing screens: 1, 4 and 8 Players, and a duet. */
export const SING_TEST_CASES = ["one", "four", "eight", "duet"] as const;
export type SingTestCase = (typeof SING_TEST_CASES)[number];

export interface SingTestSearch {
  case: SingTestCase;
  /** The frozen Song time to draw, seconds. */
  t: number;
  /** The Lyric size option. */
  lyricSize: LyricSize;
}

const DEFAULT: SingTestSearch = { case: "one", t: 6, lyricSize: "m" };
const LYRIC_SIZES: readonly LyricSize[] = ["s", "m", "l", "xl"];

function isLyricSize(value: unknown): value is LyricSize {
  return (LYRIC_SIZES as readonly unknown[]).includes(value);
}

function isCase(value: unknown): value is SingTestCase {
  return (SING_TEST_CASES as readonly unknown[]).includes(value);
}

/**
 * `?case=<one|four|eight|duet>&t=<seconds>&lyricSize=<s|m|l|xl>`; anything
 * else takes the default.
 */
export function parseSingTestSearch(search: string): SingTestSearch {
  const params = new URLSearchParams(search);
  const kase = params.get("case");
  const t = params.get("t");
  const lyricSize = params.get("lyricSize");
  const seconds = t === null || t.trim() === "" ? NaN : Number(t);
  return {
    case: isCase(kase) ? kase : DEFAULT.case,
    t: Number.isFinite(seconds) ? seconds : DEFAULT.t,
    lyricSize: isLyricSize(lyricSize) ? lyricSize : DEFAULT.lyricSize,
  };
}
