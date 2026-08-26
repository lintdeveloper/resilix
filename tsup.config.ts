import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters/otel.ts",
    "src/adapters/fetch.ts",
    "src/adapters/opossum.ts",
    "src/adapters/undici.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // Not shipped, and not emitted at all: excluding maps from the tarball while still emitting
  // them leaves dangling `sourceMappingURL` comments in the published files, and consumers'
  // bundlers then warn about a map they cannot fetch — worse than having none. Nothing local
  // needs them either: vitest runs against src/**/*.ts, never dist. Output is unminified, so
  // stack traces already land on readable code.
  sourcemap: false,
  treeshake: true,
  minify: false,
});
