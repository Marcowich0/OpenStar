import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { createAppRouter } from "./router";

/**
 * The route matches for `url`, with each route's search validated. Vitest
 * resolves the router's server build, whose `load()` answers a URL it would
 * rewrite with a redirect, so this asks the matcher directly.
 */
function leafMatch(url: string) {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [url] }),
  );
  const { pathname, search } = router.state.location;
  return router.matchRoutes(pathname, search).at(-1);
}

describe("the app's routes", () => {
  it.each([
    ["/stage", "/stage"],
    ["/", "/"],
    ["/admin", "/admin/"],
    ["/admin/downloads", "/admin/downloads"],
    ["/admin/songs", "/admin/songs"],
    ["/admin/library-problems", "/admin/library-problems"],
    ["/admin/profiles", "/admin/profiles"],
    ["/bridge", "/bridge"],
  ])("%s is served by route %s", (url, routeId) => {
    expect(leafMatch(url)?.routeId).toBe(routeId);
  });

  it("hands a well-formed Join code from the QR link to the Phone route", () => {
    const match = leafMatch("/?join=0427");
    expect(match?.routeId).toBe("/");
    expect(match?.search).toEqual({ join: "0427" });
  });

  it("keeps a malformed Join code from the QR link, for the Phone to refuse", () => {
    const match = leafMatch("/?join=12ab");
    expect(match?.routeId).toBe("/");
    expect(match?.search).toEqual({ join: "12ab" });
  });

  it("has no route for the test-only sing screen", () => {
    // The painter screenshot page is a test build of its own (#203).
    expect(leafMatch("/stage/sing-test")?.routeId).not.toBe("/stage/sing-test");
  });
});
