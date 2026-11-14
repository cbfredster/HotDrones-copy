import { resolve } from "node:path";
import { defineConfig } from "vite";

// The API server (server/index.ts) listens on PORT (default 8787). In dev, Vite proxies /api
// and /ws to it, so the browser only ever talks to one origin. If the server is not running
// the proxy just fails those requests and every integration shows as off.
const api = `http://localhost:${process.env.PORT || 8787}`;

export default defineConfig({
  server: {
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/ws": { target: api, ws: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        dashboard: resolve(__dirname, "dashboard.html"),
        board: resolve(__dirname, "board.html"),
      },
    },
  },
});
