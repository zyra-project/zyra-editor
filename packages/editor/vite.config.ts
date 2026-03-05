import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.VITE_BACKEND_URL ?? "http://localhost:8765";
const wsBackend = backend.replace(/^http/, "ws");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
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
