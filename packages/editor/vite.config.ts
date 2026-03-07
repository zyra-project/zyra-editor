import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.VITE_BACKEND_URL ?? "http://localhost:8765";
const wsBackend = (() => {
  const url = new URL(backend);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
})();

export default defineConfig({
  plugins: [react()],
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
    },
  },
});
