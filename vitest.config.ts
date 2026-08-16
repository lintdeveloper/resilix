import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts",
        // The opossum shim is verified by running opossum's OWN test suite against it
        // (`pnpm test:compat`, 362/362), not by unit tests here. Duplicating their suite to
        // satisfy a coverage threshold would add no information and a lot of maintenance.
        "src/adapters/opossum.ts",
      ],
      thresholds: {
        statements: 90,
        functions: 90,
        lines: 90,
        branches: 80,
      },
    },
  },
});
