import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // PostgreSQL specs share candidate-bound schemas; serialize files while
    // retaining the explicit concurrency scenarios inside each spec.
    fileParallelism: false,
    include: ["test/**/*.spec.ts"],
  },
});
