import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/otel.ts", "src/fetch.ts", "src/compat/opossum.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  minify: false,
});
