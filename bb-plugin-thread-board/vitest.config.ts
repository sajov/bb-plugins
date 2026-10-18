import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors the `@/*` alias from tsconfig so tests resolve exactly the way
  // `bb plugin build` does.
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: { include: ["tests/**/*.test.{ts,tsx}"] },
});
