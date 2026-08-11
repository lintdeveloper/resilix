import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      thresholds: {
        statements: 90,
        functions: 90,
        lines: 90,
        branches: 80,
      },
    },
  },
});
