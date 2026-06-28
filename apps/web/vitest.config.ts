import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx", "test/**/*.spec.ts", "test/**/*.spec.tsx"],
  },
});
