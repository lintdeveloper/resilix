/**
 * Drive traffic through the gateway and print what the policies are doing.
 *
 *   pnpm example:gateway
 *
 * Watch the `limit` column. The provider degrades from ~120ms to seconds at a
 * flat error rate; the limiter sees latency rise and walks the concurrency down
 * before the errors start, and walks it back up on recovery. That adaptation is
 * the thing that has no equivalent in npm, and it is hard to believe from prose.
 */
import { RejectedError, type RejectionReason } from "../../src/index.ts";
import { type Job, gateway, toResponse } from "./gateway.ts";
import { FakeProvider, sleep } from "./upstream.ts";

const MODEL = "gpt-oss-120b";
const TENANTS = ["acme", "globex", "initech"] as const;
/** Default long enough to show degradation AND recovery; CI overrides it. */
const RUN_MS = Number(process.env.RESILIX_EXAMPLE_MS ?? "44000");

const provider = new FakeProvider();
const tally = { ok: 0, answered: 0, shed: 0, failed: 0 };
const shedBy = new Map<RejectionReason, number>();

async function once(job: Job): Promise<void> {
  try {
    const reply = await gateway.execute(job, async (ctx) => {
      const r = await provider.call();
      // Time to first token, not time to drain. Judge a stream end-to-end and a
      // healthy 45-second completion looks like saturation.
      ctx.mark();
      return toResponse(r);
    });
    if (reply.status === 200) tally.ok++;
    else if (reply.status < 500) tally.answered++;
    else tally.failed++;
  } catch (error) {
    if (error instanceof RejectedError) {
      tally.shed++;
      shedBy.set(error.reason, (shedBy.get(error.reason) ?? 0) + 1);
    } else {
      tally.failed++;
    }
  }
}

function header(): void {
  console.log(
    "\n  t    phase        limit  inflight   p90ms |    ok  4xx  shed  fail | shed reason",
  );
  console.log(`  ${"─".repeat(88)}`);
}

function row(second: number): void {
  const m = gateway.metrics().find((x) => x.policy === "limiter")?.values ?? {};
  const top = [...shedBy.entries()].sort((a, b) => b[1] - a[1])[0];
  const cell = (v: number, w: number) => String(Math.round(v)).padStart(w);
  const cols = [
    `  ${String(second).padStart(2)}s  ${provider.phase().padEnd(11)}`,
    cell(m.limit ?? 0, 6),
    cell(m.inFlight ?? 0, 10),
    cell(m.recentMs ?? 0, 8),
    " |",
    cell(tally.ok, 6),
    cell(tally.answered, 5),
    cell(tally.shed, 6),
    cell(tally.failed, 6),
    ` | ${top ? `${top[0]} x${top[1]}` : "—"}`,
  ];
  console.log(cols.join(""));
}

async function main(): Promise<void> {
  console.log("  resilix — LLM gateway example");
  console.log("  A provider that degrades at a FLAT error rate, then recovers.");
  console.log("  Watch `limit` fall before the failures start, and rise again after.");
  header();

  const started = Date.now();
  const inFlight = new Set<Promise<void>>();
  let tick = 0;

  const printer = setInterval(() => row(++tick), 1_000);

  while (Date.now() - started < RUN_MS) {
    // ~25 requests/sec offered load, mixed tenants, one in five is background.
    for (let i = 0; i < 5; i++) {
      const job: Job = {
        model: MODEL,
        tenant: TENANTS[Math.floor(Math.random() * TENANTS.length)] ?? "acme",
        background: Math.random() < 0.2,
      };
      const p = once(job).finally(() => inFlight.delete(p));
      inFlight.add(p);
    }
    await sleep(200);
  }

  clearInterval(printer);
  await Promise.allSettled([...inFlight]);

  const total = tally.ok + tally.answered + tally.shed + tally.failed;
  console.log(`  ${"─".repeat(88)}`);
  console.log(`\n  ${total} requests offered\n`);
  console.log(`    ${String(tally.ok).padStart(5)}  succeeded`);
  console.log(
    `    ${String(tally.answered).padStart(5)}  answered 4xx — healthy, never opened the circuit`,
  );
  console.log(
    `    ${String(tally.shed).padStart(5)}  shed by resilix, fast, without touching the provider`,
  );
  console.log(`    ${String(tally.failed).padStart(5)}  failed`);
  console.log("\n  shed by reason:");
  for (const [reason, n] of [...shedBy.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${reason}`);
  }
  console.log(`
  The 4xx column is the point of the verdict model: a boolean
  'did it reject?' breaker would have opened the circuit on those.
`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
