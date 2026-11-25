import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// `pnpm dev` proxies the API and the WebSocket to a server on OPENSTAR_PORT
// (default 8080), so the browser still sees one origin.
const server = `http://localhost:${process.env.OPENSTAR_PORT ?? "8080"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": server,
      "/ws": { target: server, ws: true },
    },
  },
  test: {
    environment: "node",
  },
});
