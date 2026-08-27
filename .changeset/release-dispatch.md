---
"resilix": patch
---

`release.yml` can now be triggered manually (`workflow_dispatch`).

The publish fires on a push to `main`, and a push gives exactly one chance to run it. During the
2026-08-26 GitHub Actions outage no runs were created at all, which means a release commit landing
in that window would have consumed its changesets and left the version on `main` with nothing
published — recoverable only by pushing another commit purely to fire the event. Exposing the
dispatch is safe: `changeset publish` is a no-op for a version already on the registry.

`CONTRIBUTING.md` also now states when the branch-protection bypass is legitimate — a platform
outage or a production incident, with the local checks run first — and that it never extends to
force-push, branch deletion or tag immutability.
