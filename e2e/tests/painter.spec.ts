import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

import { expect, STAGE_VIEWPORT, test } from "../fixtures";

// The painter screenshots (#203). The canvas painter is checked only by these:
// the sing screen painted from `frame()` on fixed synthetic state at a frozen
// Song time, for 1, 4 and 8 Players and a duet.
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

const CASES = [
  { name: "one", label: "1 Player" },
  { name: "four", label: "4 Players" },
  { name: "eight", label: "8 Players" },
  { name: "duet", label: "a duet" },
] as const;

/** The frozen Song time every shot draws (a Note sits on the playhead). */
const SONG_TIME = 6;

/** The test build's file for `url`, or null for anything that is not on {@link ORIGIN}. */
function pageFile(url: string): string | null {
  const { origin, pathname } = new URL(url);
  if (origin !== ORIGIN) return null;
  const file = normalize(join(PAGE_DIR, pathname));
  return file.startsWith(PAGE_DIR + "/") ? file : null;
}

for (const { name, label } of CASES) {
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

    await page.goto(`/sing-test.html?case=${name}&t=${String(SONG_TIME)}`);
    await expect(page.locator("[data-sing-screen][data-painted]")).toHaveCount(
      1,
    );
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(`${name}.png`);

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
