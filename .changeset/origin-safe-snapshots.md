---
"resilix": minor
---

Origin-safe snapshots, and a lint rule that enforces the runtime-agnostic constraint.

**Breaking to the snapshot format** (pre-release, so no migration path is provided).
`snapshot()` previously serialised absolute readings from `Clock.now()`. That is monotonic with
an arbitrary origin — `performance.now()` counts from process start — so a snapshot taken in one
process and hydrated in another produced samples that looked fresh, or dated in the future.
Since serverless carry-over is the entire reason `snapshot()`/`hydrate()` exist, this was wrong
in exactly the case it was built for.

- `Clock` gains an optional `wallNow(): number` (epoch ms), used only by snapshot/hydrate and
  never on the hot path.
- `WindowSnapshot` stores `ageMs[]` instead of absolute `at[]`.
- `BreakerSnapshot` stores `lastProbeAgeMs` and `nextAttemptInMs` plus `wallClockAt`, replacing
  absolute `lastProbeAt` / `nextAttemptAt`.
- `hydrate()` accounts for how long the snapshot sat idle: a breaker open for 30s that was
  serialised and restored 20s later resumes with 10s remaining, and window samples older than
  `maxAgeMs` are dropped rather than resurrected.
- Clocks without `wallNow` still work; the idle gap is simply unaccounted for.
- `FakeClock` carries both clocks on deliberately different origins, so a test that confuses
  monotonic and epoch time fails immediately.

Also: `biome` now enforces `style/noRestrictedGlobals` over `src/`, banning `document`,
`window`, `localStorage` and friends as well as `process`, `require` and `Buffer` — so neither a
browser-only nor a Node-only global can creep into a runtime-agnostic core.
