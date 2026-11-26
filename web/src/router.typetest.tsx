// Compile-time checks of the route tree. This file is never run: `tsc` checks
// it, and each `@ts-expect-error` fails the build if its line stops being an
// error, so a typo in a route or its parameters stays a compile error.

import { Link, useNavigate } from "@tanstack/react-router";

export function RouteTypeChecks() {
  const navigate = useNavigate();

  void navigate({ to: "/stage" });
  void navigate({ to: "/admin/library-problems" });
  void navigate({ to: "/", search: { join: "1234" } });

  void navigate({ to: "/stage", search: { perf: true, lanes: 8 } });

  // @ts-expect-error: `lanes` is a number of lanes.
  void navigate({ to: "/stage", search: { perf: true, lanes: "8" } });

  // @ts-expect-error: there is no `/stages` route.
  void navigate({ to: "/stages" });

  // @ts-expect-error: the Admin area has no `/admin/settings` section.
  void navigate({ to: "/admin/settings" });

  // @ts-expect-error: `/` has no `jion` search parameter.
  void navigate({ to: "/", search: { jion: "1234" } });

  // @ts-expect-error: a Join code is a string.
  void navigate({ to: "/", search: { join: 1234 } });

  return (
    <>
      <Link to="/bridge">Mic bridge</Link>
      {/* @ts-expect-error: there is no `/brigde` route. */}
      <Link to="/brigde">Mic bridge</Link>
    </>
  );
}
