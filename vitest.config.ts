import { defineConfig } from "vitest/config";

// Only src/lib is covered: it holds the pure functions (abundance lookups, taxonomy
// resolution, search ranking) that are worth testing without a browser in the way.
export default defineConfig({
  test: {
    globals: true,
    include: ["src/lib/**/*.test.ts"],
  },
});
