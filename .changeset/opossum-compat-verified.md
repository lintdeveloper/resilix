---
"resilix": minor
---

The opossum compatibility claim is now measured, not asserted.

`resilix/compat/opossum` passes **362 of 362** of opossum's own test suite, run unmodified
against the shim. `pnpm test:compat` reproduces it and fails if the README's number drifts.

Running their suite rather than tests written from their documentation found a dozen
behavioural differences. The three that no amount of reading would have surfaced:

- **opossum's default `this` for the action is the action function itself**, not undefined.
  Their context-test hangs a property off the function and expects a plain `fire()` to read it.
- **The timeout timer must not be unref'd.** resilix's own pipeline unrefs so a pending deadline
  cannot hold a process open, and copying that here meant a caller whose own timers were unref'd
  never settled at all — node exited first. Fixing it moved the suite from 59% to 75%.
- **A refusal must reject synchronously.** An `async` function defers even an immediate throw by
  a microtask; their half-open test fires into an open circuit and calls `t.end()` in the very
  next `.then`, so arriving one tick late meant the assertion never ran.

Newly implemented to match: `shutdown`/`isShutdown`, `healthCheck`, `options`, `action`,
`toJSON`, `call`, `getSignal`/`getAbortController`, the abort-controller family, the bucketed
rolling status window with `status` as an event emitter, rolling percentiles, `options.state`
priming, `options.enabled`, warm-up, the `maxFailures` deprecation, zero-valued options, and
`errorFilter` receiving the invocation arguments.

Three of their files are excluded and named in the script: they `require('../lib/…')`, so they
unit-test opossum's internals rather than its public API.
