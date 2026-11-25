import { defineConfig, devices } from "@playwright/test";

// `just e2e` (scripts/e2e.sh) starts the built binary and passes its address.
const baseURL = process.env.OPENSTAR_E2E_BASE_URL;
if (baseURL === undefined || baseURL === "") {
  throw new Error(
    "OPENSTAR_E2E_BASE_URL is not set: run the suite with `just e2e`",
  );
}

export default defineConfig({
  testDir: "tests",
  // One server holds one Party, so tests run one after another.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env.CI === "true",
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  outputDir: "test-results",
  // Screenshot baselines (#203) are committed under tests/__screenshots__/.
  // Only `just update-screenshots` writes them; every other run compares, and
  // a missing baseline fails too. On a mismatch test-results/ holds the
  // expected, actual and diff images (CI keeps them as an artifact).
  updateSnapshots: "none",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFileName}/{arg}{ext}",
  expect: {
    // Exact: the shots come from the one pinned Playwright image.
    toHaveScreenshot: {
      threshold: 0,
      maxDiffPixels: 0,
      animations: "disabled",
    },
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Chromium only: Playwright's WebKit is not iOS Safari, and Firefox is not a target.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
