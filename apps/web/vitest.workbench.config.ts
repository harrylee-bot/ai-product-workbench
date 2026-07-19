import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const workspaceRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": workspaceRoot },
  },
  test: {
    environment: "node",
    include: [
      "app/api/**/*.spec.ts",
      "app/**/*.spec.tsx",
      "lib/auth/**/*.spec.ts",
      "lib/workbench/**/*.spec.ts",
      "lib/workbench/**/*.spec.tsx",
      "components/auth/**/*.spec.ts",
      "components/auth/**/*.spec.tsx",
      "components/share/**/*.spec.tsx",
      "components/workbench/**/*.spec.tsx",
    ],
  },
});
