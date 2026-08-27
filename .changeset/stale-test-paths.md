---
"resilix": patch
---

Three test suites had been silently disabled since the `src/` reorganisation, and none of them
ran in CI, so nothing reported it.

- `test:integration` pointed at `src/sql-integration.test.ts` (now `src/scenarios/`)
- `test:perf` pointed at `src/limiter.simulation.test.ts` (now `src/policies/`)
- `test:compat` generated its opossum shim once and cached it, so every harness kept requiring
  `dist/compat/opossum.cjs` after the shim moved to `dist/adapters/`. The whole suite reported
  **0 of 0 STALLED** — meaning the README's "362 of 362" claim was unverifiable for days. The
  shim is now rewritten on every run, since it is a *generated* file rather than a cached one.

All three now run in CI, and `pnpm test:paths` fails the build if any path named in a
`package.json` script does not exist. `verify` runs it first, so it fails in a second rather than
after a full coverage pass.
