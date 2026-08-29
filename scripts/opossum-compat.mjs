#!/usr/bin/env node
/**
 * Run opossum's OWN test suite against `resilix/compat/opossum`.
 *
 * This is the only honest way to substantiate a drop-in claim. Tests written from a competitor's
 * documentation prove that you read the documentation; running their suite proves the behaviour
 * matches. Doing this found ten behavioural differences that no amount of reading would have —
 * among them that opossum's default `this` for the action is the action function itself, and
 * that its timeout timer must not be unref'd or a caller whose own timers are unref'd never
 * settles.
 *
 *   node scripts/opossum-compat.mjs            # fetch (if needed), build, run, report
 *   node scripts/opossum-compat.mjs --refresh  # re-fetch the pinned suite
 *
 * Network access is needed on first run only. The suite is cached under .opossum-compat/,
 * which is git-ignored.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = join(ROOT, ".opossum-compat");
// PINNED, not "main". CI re-fetches on every run because .opossum-compat/ is not cached, so
// tracking a branch meant the README's "362 of 362" was measured against whatever opossum had
// merged that morning — a required check whose expected value upstream can change without us.
// Bump this deliberately, with the new total, and never as a drive-by.
const REF = process.env.OPOSSUM_REF ?? "decbedf63d7815049233e544dcb351590ff0c84e";

/** Their suite, minus the files that unit-test opossum's private modules. */
const TESTS = [
  "common.js",
  "test.js",
  "closed-test.js",
  "half-open-test.js",
  "error-filter-test.js",
  "options-test.js",
  "state-test.js",
  "volume-threshold-test.js",
  "enable-disable-test.js",
  "circuit-shutdown-test.js",
  "context-test.js",
  "health-check-test.js",
  "warmup-test.js",
  "rolling-event-emitter-test.js",
];

/**
 * Excluded, with the reason. These `require('../lib/...')` — they are unit tests of opossum's
 * internal modules, not of its public API, so no compatibility layer can ever satisfy them.
 */
const EXCLUDED = {
  "cache.js": "requires ../lib/cache — unit tests an internal module",
  "semaphore-test.js": "requires ../lib/semaphore — unit tests an internal module",
  "status-test.js": "requires ../lib/status.js — unit tests an internal module",
};

const RAW = (f) => `https://raw.githubusercontent.com/nodeshift/opossum/${REF}/test/${f}`;

/**
 * Point opossum's `require('../')` at our build.
 *
 * Rewritten on EVERY run, not just when the harness is first created. It used to be generated
 * once inside fetchSuite() and then cached alongside the downloaded suite — so when the shim
 * moved from dist/compat/ to dist/adapters/ during the src/ reorg, every cached harness kept
 * requiring a path that no longer existed. The whole suite reported 0 of 0 STALLED, which is a
 * generated file being treated as a downloaded one.
 */
const writeShim = () => {
  writeFileSync(
    join(HARNESS, "shim.cjs"),
    `const mod = require(${JSON.stringify(join(ROOT, "dist", "adapters", "opossum.cjs"))});
module.exports = mod.default ?? mod;
module.exports.default = module.exports;
`,
  );
};

const fetchSuite = async () => {
  mkdirSync(join(HARNESS, "test", "browser"), { recursive: true });
  for (const f of [...TESTS, "browser/browser-tap.js"]) {
    const res = await fetch(RAW(f));
    if (!res.ok) throw new Error(`could not fetch ${f}: ${res.status}`);
    writeFileSync(join(HARNESS, "test", f), await res.text());
  }
  writeFileSync(
    join(HARNESS, "package.json"),
    `${JSON.stringify({ name: "opossum-compat-harness", private: true, main: "./shim.cjs" }, null, 2)}\n`,
  );
  writeShim();
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "tape"], {
    cwd: HARNESS,
    stdio: "ignore",
  });
};

const run = (file) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [join("test", file)], { cwd: HARNESS });
    let out = "";
    const kill = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (code, signal) => {
      clearTimeout(kill);
      const pass = Number(out.match(/^# pass\s+(\d+)/m)?.[1] ?? 0);
      const fail = Number(out.match(/^# fail\s+(\d+)/m)?.[1] ?? 0);
      const stalled = !/^# pass/m.test(out);
      done({ file, pass, fail, stalled, out, code, signal });
    });
  });

const main = async () => {
  if (process.argv.includes("--refresh") || !existsSync(join(HARNESS, "shim.cjs"))) {
    console.log(`fetching opossum@${REF} test suite…`);
    await fetchSuite();
  } else {
    // The suite is cached; the shim is generated, so refresh it regardless. See writeShim().
    writeShim();
  }
  if (!existsSync(join(ROOT, "dist", "adapters", "opossum.cjs"))) {
    console.log("building…");
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
  }

  // Retry a file that produced no TAP summary, once, before believing it.
  //
  // opossum's test.js is timing-sensitive: it opens a breaker, waits exactly
  // `resetTimeout` with a setTimeout of the same duration, then fires and expects
  // a half-open probe. That is a dead heat, and a loaded CI runner decides it — a
  // late fire rejects with EOPENBREAKER on a `.then()` chain that has no
  // `.catch()`, so the process dies and the file reports 0 of 0.
  //
  // Observed failing on two pull requests and passing on a rerun of the SAME
  // commit with no changes. This suite is a REQUIRED check, and a flaky required
  // check is worse than none: it teaches you to ignore red. A single retry keeps
  // the signal (a genuine break fails twice) without the noise.
  //
  // This is not a root cause. The race is in opossum's test, not in the shim, and
  // matching their exact timer ordering is not something a compatibility layer
  // can guarantee from the outside.
  const results = [];
  for (const f of TESTS.filter((f) => f !== "common.js")) {
    let result = await run(f);
    if (result.stalled) {
      console.log(`  ${f} produced no summary — retrying once`);
      const second = await run(f);
      if (!second.stalled) result = second;
      else result = { ...second, retried: true };
    }
    results.push(result);
  }

  let pass = 0;
  let fail = 0;
  console.log(`\n${"FILE".padEnd(32)}${"PASS".padStart(6)}${"FAIL".padStart(6)}`);
  console.log("-".repeat(46));
  const stalls = results.filter((r) => r.stalled);
  for (const r of results.sort((a, b) => a.file.localeCompare(b.file))) {
    pass += r.pass;
    fail += r.fail;
    const note = r.stalled ? "  STALLED" : "";
    console.log(
      `${r.file.padEnd(32)}${String(r.pass).padStart(6)}${String(r.fail).padStart(6)}${note}`,
    );
  }
  console.log("-".repeat(46));
  const pct = Math.round((100 * pass) / Math.max(1, pass + fail));
  console.log(
    `${"TOTAL".padEnd(32)}${String(pass).padStart(6)}${String(fail).padStart(6)}   ${pct}%\n`,
  );

  // A STALLED file used to report only the word STALLED, with the child's output discarded — so
  // when test.js stalled on a CI runner while passing locally, there was nothing to diagnose from
  // and the cause had to be guessed at. Print the exit status and the tail of what it actually
  // said.
  for (const r of stalls) {
    console.error(
      `\n${r.file} produced no TAP summary on ${r.retried ? "two attempts" : "one attempt"}` +
        `  (exit=${r.code} signal=${r.signal})`,
    );
    const tail = r.out.trimEnd().split("\n").slice(-12);
    for (const line of tail) console.error(`    ${line}`);
    if (r.out.trim() === "") console.error("    (no output at all)");
  }

  console.log("Excluded, and why:");
  for (const [f, why] of Object.entries(EXCLUDED)) console.log(`  ${f.padEnd(20)} ${why}`);

  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const claimed = readme.match(/passes \*\*(\d+) of (\d+)\*\* of opossum/);
  if (claimed) {
    const [, cp, ct] = claimed;
    const actual = `${pass} of ${pass + fail}`;
    if (`${cp} of ${ct}` !== actual) {
      console.error(`\nREADME claims ${cp} of ${ct}; the suite actually gives ${actual}.`);
      process.exit(1);
    }
    console.log(`\nREADME claim of ${cp} of ${ct} matches.`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
