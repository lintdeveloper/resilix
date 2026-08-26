# Deploying the docs site

Built by `.github/workflows/docs.yml` on every push to `main` and deployed to GitHub Pages. Pull
requests build and audit but never deploy — a fork PR must not be able to publish.

Locally: `pnpm docs:dev` to work on it, `pnpm docs:check` to build and audit every internal link,
`#anchor`, and `file:line` citation the way CI does.

## The public URL lives in one place

`docs/.vitepress/config.ts`:

```ts
const SITE = "https://resilix.js.org";
const base = "/";
```

Everything derives from those two — sitemap hostname, `og:url`, `og:image`, `twitter:image`. The
previous cutover had the hostname written out in eleven files across four formats, which is how
you end up with a half-migrated site.

**`base` and the domain flip together, never separately.** On a custom domain the site is served
from the root, so `base` must be `"/"`. On a project page (`lintdeveloper.github.io/resilix`) it
must be `"/resilix/"` or every asset 404s. `scripts/check-links.mjs` now reads the base out of the
built HTML rather than hardcoding it, so it cannot silently stop matching links after a change.

## Why resilix.js.org, and what went wrong the first time

`resilix.github.io` is unobtainable — that hostname comes from a GitHub *account* name, and
`github.com/Resilix` is a dormant account (created Aug 2023, no repos). GitHub does not release
inactive usernames.

The first request, [js-org/js.org#12312](https://github.com/js-org/js.org/pull/12312), was
**closed unmerged on 2026-08-20**. It was opened deliberately *without* setting the custom domain,
so that reviewers would find a working site rather than a redirect to a hostname that does not
resolve yet — js.org's most common rejection reason is no content on the page. A maintainer asked
for the domain to be set anyway, nobody replied, and it was closed for inactivity.

**The lesson: follow their documented order, and answer the thread.** Their README puts the custom
domain at step 3 and the pull request at step 4. Accept that the site is unreachable in between —
`lintdeveloper.github.io/resilix` 301-redirects to `resilix.js.org`, which serves js.org's
wildcard placeholder until the entry is merged.

## The cutover, in order

1. **Set the custom domain** on the Pages config. An artifact `CNAME` file is ignored when
   publishing via a workflow, so it must be set on the repo:

   ```bash
   gh api -X PUT repos/lintdeveloper/resilix/pages -f cname=resilix.js.org
   ```

   Or Settings → Pages → Custom domain. Expect a DNS-check warning: correct, DNS does not point
   here until js.org merges.

2. **Set `SITE` and `base`** in `docs/.vitepress/config.ts`, and update the plain-text links in
   `README.md`, `CONTRIBUTING.md`, `READING.md` and `docs/public/robots.txt`.

3. **Open the js.org PR** — one line added to `cnames_active.js`, in alphabetical order:

   ```js
   "resilix": "lintdeveloper.github.io/resilix",
   ```

   Then **watch the thread** and answer within a day or two.

4. **Verify after merge.** DNS can take up to 24 hours:

   ```bash
   curl -s https://raw.githubusercontent.com/js-org/js.org/master/cnames_active.js | grep '"resilix"'
   curl -sI https://resilix.js.org/ | head -1
   curl -s https://resilix.js.org/ | grep -c 'href="/assets'   # assets at root, not /resilix/
   ```

   Until the certificate is issued HTTPS fails while HTTP works. That resolves itself; enforce
   HTTPS in the Pages settings once it does.

## If it is rejected again

js.org is free but it is not ownership — their
[naming-conflict policy](https://github.com/js-org/js.org/wiki/Naming-Conflicts) breaks ties on
GitHub stars after a three-month grace period. `resilix.dev` is unregistered (~$14/yr) and is the
only route that actually locks the name down. The steps above are identical for it, minus the PR
and plus two DNS records — and because you control the DNS, there is no review window and no
outage.
