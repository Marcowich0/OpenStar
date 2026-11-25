// `/stage/sing-test?case=<one|four|eight|duet>&t=<seconds>`: the sing screen
// from synthetic state at a frozen Song time, for the painter screenshots
// (#58). It is not linked from anywhere and no Party state reaches it, so a
// normal Party never shows it. Wait for `[data-sing-screen][data-painted]`
// before taking a screenshot.

import { useSearch } from "@tanstack/react-router";
import { useMemo } from "react";

import { SingScreen } from "./SingScreen";
import { syntheticSing } from "./syntheticSing";

const NO_OFFSET = () => 0;

export function SingTestScreen() {
  const search = useSearch({ from: "/stage/sing-test" });
  const state = useMemo(() => syntheticSing(search.case), [search.case]);
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
