import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// `pnpm dev` proxies the API and the WebSocket to a server on OPENSTAR_PORT
// (default 8080), so the browser still sees one origin.
const server = `http://localhost:${process.env.OPENSTAR_PORT ?? "8080"}`;

// `vite build --mode screenshots` builds only the test-only pages into
// e2e/generated/, for `just e2e` and `just update-screenshots`: the painter
// screenshot page (`sing-test.html`, #203) and the Admin area with its
// test-only guarded action (`admin-test.html`, #185). The production build
// has the one entry `index.html` and never contains them.
const SCREENSHOTS_OUT_DIR = "../e2e/generated/screenshot-page";

// The `.test.ts` files that need a DOM (a `document`, `window`, media or
// canvas elements, Testing Library's `renderHook`). They run in jsdom with the
// component tests; every other `.test.ts` runs in plain node, where one that
// needs a DOM fails loudly with "document is not defined": add it here.
const DOM_TESTS = [
  "src/live/browserLive.test.ts",
  "src/phone/useKeyboardInset.test.ts",
  "src/playback/songPreview.test.ts",
  "src/stage/input/gamepad.test.ts",
  "src/stage/perf/syntheticLanes.test.ts",
  "src/stage/scenes/sing/pauseHint.test.ts",
  "src/stage/scenes/sing/singSetup.test.ts",
  "src/stage/scenes/sing/stageSong.test.ts",
  "src/stage/scenes/sing/stageSongMicSettings.test.ts",
  "src/stage/sing/avOffset.test.ts",
  "src/stage/sing/frame.test.ts",
  "src/stage/sing/lineRatingWriter.test.ts",
  "src/stage/sing/syntheticSing.test.ts",
  "src/theme/readToken.test.ts",
  "src/theme/stageTheme.test.ts",
  "src/theme/themes.test.ts",
  "src/ui/formField.test.ts",
  "src/ui/generatedCover.test.ts",
];

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    // Every asset (Fredoka files, SVG icons) is a file of its own in the
    // build, served by OpenStar, never inlined as a data URL.
    assetsInlineLimit: 0,
    ...(mode === "screenshots"
      ? {
          outDir: SCREENSHOTS_OUT_DIR,
          emptyOutDir: true,
          rolldownOptions: { input: ["sing-test.html", "admin-test.html"] },
        }
      : {}),
  },
  server: {
    // Tests import the shared test cases from the repository's `fixtures/`
    // (`import cases from "../../../fixtures/…/x.json?raw"`).
    fs: { allow: [".", "../fixtures"] },
    proxy: {
      "/api": server,
      "/ws": { target: server, ws: true },
    },
  },
  test: {
    // Two projects, both inheriting the settings below: the component tests
    // and DOM_TESTS get jsdom and its setup file, everything else runs in
    // plain node. A jsdom per test file was a third of the suite's time.
    projects: [
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["**/*.test.tsx", ...DOM_TESTS],
          setupFiles: ["src/test/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...DOM_TESTS],
        },
      },
    ],
    // Vitest turns CSS imports into "", even with `?raw`; process `?raw` CSS
    // so tests can read a stylesheet's text (the theme, the icons).
    css: { include: [/\.css\?raw$/] },
    // Generous limits: a test waits for a condition, never for a time, so a
    // long limit costs nothing when it passes. The 5 s default failed
    // correct tests whenever the machine (or a CI runner) was busy.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
}));
