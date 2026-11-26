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
    ["/stage/playback?song=3", "/stage/playback"],
    ["/", "/"],
    ["/admin", "/admin/"],
    ["/admin/downloads", "/admin/downloads"],
    ["/admin/songs", "/admin/songs"],
    ["/admin/songs/7/timing", "/admin/songs/$song/timing"],
    ["/admin/library-problems", "/admin/library-problems"],
    ["/admin/profiles", "/admin/profiles"],
    ["/bridge", "/bridge"],
  ])("%s is served by route %s", (url, routeId) => {
    expect(leafMatch(url)?.routeId).toBe(routeId);
  });

  it("hands the Song's id to the Timing editor", () => {
    expect(leafMatch("/admin/songs/7/timing")?.params).toEqual({ song: 7 });
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

  it("hands the Song to play to the playback view", () => {
    expect(leafMatch("/stage/playback?song=3")?.search).toEqual({ song: 3 });
    expect(leafMatch("/stage/playback?song=x")?.search).toEqual({
      song: undefined,
    });
  });

  it("hands the perf overlay and synthetic lanes to the Stage", () => {
    expect(leafMatch("/stage")?.search).toEqual({
      perf: undefined,
      lanes: undefined,
    });
    expect(leafMatch("/stage?perf")?.search).toEqual({
      perf: true,
      lanes: undefined,
    });
    expect(leafMatch("/stage?perf&lanes=8")?.search).toEqual({
      perf: true,
      lanes: 8,
    });
  });

  it.each(["0", "9", "2.5", "x", "-1"])(
    "rejects ?perf&lanes=%s on the Stage",
    (lanes) => {
      expect(leafMatch(`/stage?perf&lanes=${lanes}`)?.search).toEqual({
        perf: true,
        lanes: undefined,
      });
    },
  );

  it("ignores synthetic lanes without the perf overlay", () => {
    expect(leafMatch("/stage?lanes=8")?.search).toEqual({
      perf: undefined,
      lanes: undefined,
    });
  });

  it("has no route for the test-only sing screen", () => {
    // The painter screenshot page is a test build of its own (#203).
    expect(leafMatch("/stage/sing-test")?.routeId).not.toBe("/stage/sing-test");
  });
});
