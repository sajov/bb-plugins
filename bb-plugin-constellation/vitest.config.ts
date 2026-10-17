import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    // A cold Vite cache can exceed the 10 s default when a suite loads the app bundle.
    hookTimeout: 30_000,
  },
});
