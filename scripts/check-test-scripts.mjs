// Every test path named in package.json scripts must exist.
//
// `test:integration` and `test:perf` both pointed at pre-reorg paths for days. Neither runs in
// `verify` or in CI — they need a Postgres and an opt-in env var — so `vitest`'s "No test files
// found" exit code was never observed by anyone. A moved file silently disabled two suites.
//
// Zero dependencies, like everything else here.
import { existsSync, readFileSync } from "node:fs";

const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
const problems = [];
let checked = 0;

for (const [name, body] of Object.entries(scripts ?? {})) {
  // any src/… path with a file extension, wherever it appears in the command
  for (const [, path] of String(body).matchAll(/(src\/[\w./-]+\.[cm]?tsx?)/g)) {
    checked++;
    if (!existsSync(path)) problems.push(`${name} → ${path} (no such file)`);
  }
}

if (checked === 0) {
  console.error("✗ no test paths matched — this checker has gone inert");
  process.exit(1);
}
if (problems.length) {
  console.error(`✗ ${problems.length} stale path(s) in package.json scripts:\n`);
  for (const p of problems) console.error(`   ${p}`);
  process.exit(1);
}
console.log(`✓ ${checked} test paths in package.json scripts all exist`);
