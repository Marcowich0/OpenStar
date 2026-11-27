import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

import { expect, STAGE_VIEWPORT, test } from "../fixtures";

// The painter screenshots (#203). The canvas painter is checked only by these:
// the sing screen painted from `frame()` on fixed synthetic state at a frozen
// Song time, for 1, 4 and 8 Players, a duet, and 2 Players of a Song with no
// video, over the blobs (#263), and the title card (#264) at 1 s.
//
// The page (`web/sing-test.html`) is a test build of its own, which `just e2e`
// writes to e2e/generated/screenshot-page/ (`vite build --mode screenshots`).
// The browser gets it from disk through a route on a made-up origin, so the
// production binary never holds it and nothing reaches the network. The
// committed baselines live in tests/__screenshots__/; only
// `just update-screenshots` writes them.

const PAGE_DIR = join(import.meta.dirname, "../generated/screenshot-page");
const ORIGIN = "http://screenshots.openstar.invalid";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

/** The frozen Song time most shots draw (a Note sits on the playhead). */
const SONG_TIME = 6;

const CASES = [
  { name: "one", label: "1 Player", t: SONG_TIME, shot: "one" },
  { name: "four", label: "4 Players", t: SONG_TIME, shot: "four" },
  { name: "eight", label: "8 Players", t: SONG_TIME, shot: "eight" },
  { name: "duet", label: "a duet", t: SONG_TIME, shot: "duet" },
  // The title card and pause hint show from 0 to 4 s.
  {
    name: "one",
    label: "1 Player with the title card at 1 s",
    t: 1,
    shot: "title-card",
  },
  {
    name: "noVideo",
    label: "no video, 2 Players",
    t: SONG_TIME,
    shot: "noVideo",
  },
] as const;

/** The test build's file for `url`, or null for anything that is not on {@link ORIGIN}. */
function pageFile(url: string): string | null {
  const { origin, pathname } = new URL(url);
  if (origin !== ORIGIN) return null;
  const file = normalize(join(PAGE_DIR, pathname));
  return file.startsWith(PAGE_DIR + "/") ? file : null;
}

for (const { name, label, t, shot } of CASES) {
  test(`the painter draws the sing screen for ${label}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: STAGE_VIEWPORT,
      deviceScaleFactor: 1,
      baseURL: ORIGIN,
    });
    // The test build comes from disk; nothing else is served.
    await context.route("**/*", async (route) => {
      const file = pageFile(route.request().url());
      const body =
        file === null ? null : await readFile(file).catch(() => null);
      if (file === null || body === null) {
        await route.abort();
        return;
      }
      await route.fulfill({
        body,
        contentType: CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      });
    });
    const page = await context.newPage();

    await page.goto(`/sing-test.html?case=${name}&t=${String(t)}`);
    await expect(page.locator("[data-sing-screen][data-painted]")).toHaveCount(
      1,
    );
    await page.evaluate(() => document.fonts.ready);
    // The lyric bar's Lines come in with a CSS animation (`animate-line-in`);
    // a shot taken while one plays catches it half-way. Wait for every finite
    // animation on the page to end (the looping ones never do).
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished),
      ),
    );
    await expect(page).toHaveScreenshot(`${shot}.png`);

    await context.close();
  });
}

test("the production binary does not serve the screenshot page", async ({
  stage,
}) => {
  // Any unknown path gets the app's own index.html, not the test page.
  const app = await (await stage.request.get("/")).text();
  const html = await (await stage.request.get("/sing-test.html")).text();
  expect(html).toBe(app);

  await stage.goto("/stage/sing-test?case=one&t=6");
  await stage.waitForLoadState("networkidle");
  await expect(stage.locator("[data-sing-screen]")).toHaveCount(0);
});
