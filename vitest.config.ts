import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Two projects: "integration" (backend tests in test/, real filesystem, node) and "unit" (web components in jsdom
// plus pure shared logic in test/unit/). `npm run test:unit` / `npm run test:integration` select one; `npm test` runs both.
export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "integration", include: ["test/**/*.test.ts"], exclude: ["test/unit/**"], environment: "node", testTimeout: 30000, pool: "forks" },
      },
      {
        plugins: [react()],
        test: {
          name: "unit",
          include: ["src/web/**/*.test.{ts,tsx}", "test/unit/**/*.test.ts"],
          environment: "jsdom",
          setupFiles: ["src/web/test/setup.ts"],
          testTimeout: 15000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/web/test/**", "src/web/main.tsx", "src/server/main.ts"],
      reporter: ["text-summary", "text", "json-summary", "html"],
      reportsDirectory: "coverage",
    },
  },
});
