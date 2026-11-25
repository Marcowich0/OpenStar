import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// `pnpm dev` proxies the API and the WebSocket to a server on OPENSTAR_PORT
// (default 8080), so the browser still sees one origin.
const server = `http://localhost:${process.env.OPENSTAR_PORT ?? "8080"}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Every asset (Fredoka files, SVG icons) is a file of its own in the
    // build, served by OpenStar, never inlined as a data URL.
    assetsInlineLimit: 0,
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
    // jsdom for the few component tests (Testing Library); everything else is
    // pure functions and does not care.
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    // Vitest turns CSS imports into "", even with `?raw`; process `?raw` CSS
    // so tests can read a stylesheet's text (the theme, the icons).
    css: { include: [/\.css\?raw$/] },
  },
});
