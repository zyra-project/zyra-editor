import { readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.VITE_BACKEND_URL ?? "http://localhost:8765";
const wsBackend = (() => {
  const url = new URL(backend);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
})();

const posterDir = resolve(__dirname, "../../poster");

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/** Serve the monorepo poster/ directory at /poster/ in dev mode. */
function servePoster(): Plugin {
  return {
    name: "serve-poster",
    configureServer(server) {
      // No return → middleware registers BEFORE Vite internals,
      // so it intercepts /poster/ before the SPA fallback.
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";

        if (url === "/poster") {
          res.writeHead(301, { Location: "/poster/" });
          res.end();
          return;
        }

        if (!url.startsWith("/poster/")) return next();

        const relPath = url.slice("/poster".length);
        const filePath = join(
          posterDir,
          relPath === "/" ? "index.html" : decodeURIComponent(relPath),
        );

        if (!filePath.startsWith(posterDir)) return next();

        try {
          const content = readFileSync(filePath);
          res.writeHead(200, {
            "Content-Type":
              mimeTypes[extname(filePath)] || "application/octet-stream",
            "Content-Length": content.length,
          });
          res.end(content);
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [servePoster(), react()],
  server: {
    port: 5173,
    watch: {
      usePolling: !!process.env.VITE_USE_POLLING,
      interval: 1000,
    },
    proxy: {
      "/v1": backend,
      "/ws": {
        target: wsBackend,
        ws: true,
      },
      "/health": backend,
      "/ready": backend,
    },
  },
});
