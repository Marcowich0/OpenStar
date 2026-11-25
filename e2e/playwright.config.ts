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
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Chromium only: Playwright's WebKit is not iOS Safari, and Firefox is not a target.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
