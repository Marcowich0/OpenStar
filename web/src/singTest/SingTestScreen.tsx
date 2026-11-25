// The sing screen from synthetic state at a frozen Song time, for the painter
// screenshots (#203). Only the test-only `sing-test.html` page renders it; no
// Party state reaches it.

import { useMemo } from "react";

import { SingScreen } from "../stage/sing/SingScreen";
import { syntheticSing } from "../stage/sing/syntheticSing";
import type { SingTestSearch } from "./search";

const NO_OFFSET = () => 0;

export function SingTestScreen({ search }: { search: SingTestSearch }) {
  const state = useMemo(() => syntheticSing(search.case), [search.case]);
  // A frozen clock: every frame draws the same Song time.
  const clock = useMemo(() => ({ songTime: () => search.t }), [search.t]);
  return (
    <SingScreen
      state={state}
      clock={clock}
      avOffset={NO_OFFSET}
      backdrop={<div className="absolute inset-0 bg-slate" />}
    />
  );
}
