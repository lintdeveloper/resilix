// Cloudflare Workers guard.
//
// Workers rejects timers, async I/O and random values in GLOBAL SCOPE. Importing resilix at
// module scope must therefore be side-effect free. cockatiel fails this exact test — `import
// { retry } from 'cockatiel'` crashes `wrangler dev` (their #105, declined upstream) — and it
// costs them the entire edge segment.
//
// The pipeline is built at module scope ON PURPOSE: that is the thing being proven safe.
import { breaker, pipeline } from "../dist/index.js";

const api = pipeline({
  key: (req) => new URL(req.url).host,
  policies: [breaker({ slowCallMs: 3_000 })],
  timeoutMs: 5_000,
});

export default {
  async fetch(request) {
    const gate = api.gate(request);
    if (!gate.ok) return new Response(`refused: ${gate.reason}`, { status: 503 });
    gate.settle({ status: 200 }, 12);
    return new Response("ok");
  },
};
