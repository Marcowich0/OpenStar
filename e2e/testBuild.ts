import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

import type { BrowserContext } from "@playwright/test";

// The test-only pages (`web/sing-test.html`, `web/admin-test.html`), which
// `just e2e` builds into e2e/generated/screenshot-page/ with
// `vite build --mode screenshots`. The production binary never holds them.

export const TEST_BUILD_DIR = join(
  import.meta.dirname,
  "generated/screenshot-page",
);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

/**
 * Serves the test build's files to `context` on the server's own origin,
 * so a test page talks to the real server (its API, its WebSocket):
 * a path the test build holds comes from disk, anything else goes on to
 * the server.
 */
export async function serveTestBuild(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const { pathname } = new URL(route.request().url());
    const file = normalize(join(TEST_BUILD_DIR, pathname));
    const body = file.startsWith(TEST_BUILD_DIR + "/")
      ? await readFile(file).catch(() => null)
      : null;
    if (body === null) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body,
      contentType: CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    });
  });
}
