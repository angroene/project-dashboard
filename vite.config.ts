import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: `npm run dev:server` (API on 127.0.0.1:8790) + `npm run dev:web` (UI on 5173, proxies /api).
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true, sourcemap: false },
  server: { host: "127.0.0.1", port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8790", changeOrigin: false } } },
});
