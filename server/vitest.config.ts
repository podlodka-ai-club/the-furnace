import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    // PGLite and Temporal integration tests use shared local services and are flaky under file parallelism.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    setupFiles: ["tests/ui/setup.ts"],
  },
});
