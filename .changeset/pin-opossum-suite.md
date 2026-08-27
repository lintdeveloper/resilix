---
"resilix": patch
---

The opossum compatibility suite is now pinned to a commit instead of tracking `main`.

`.opossum-compat/` is not cached in CI, so every run re-fetched the suite — meaning the README's
"362 of 362" was measured against whatever opossum had merged that morning. A required check whose
expected value can change upstream without us is not a check. Bumping the pin is now a deliberate
act, with the new total.

A stalled file also reports its exit status and the tail of its output. It previously printed only
the word `STALLED` with the child's output discarded, so when `test.js` produced no TAP summary on
a CI runner while passing locally, there was nothing to diagnose from.
