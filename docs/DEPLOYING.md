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

## docs/public — files served verbatim from the root

Everything in `docs/public/` is copied to the site root at build time, so
`docs/public/x` becomes `https://resilix.js.org/x`. Nothing there is processed — it is where files
that must exist at an exact path live.

| File | Why |
|---|---|
| `favicon.svg` | browser tab icon |
| `og.png` | social card, 1200×630, regenerated from `scripts/og-card.html` |
| `robots.txt` | points crawlers at the sitemap |
| `resilix-architecture.pdf` | C4 architecture and the original version plan |
| `google*.html` | **Google Search Console ownership proof — do not delete** |

That last one is fragile: Search Console re-checks it periodically and **silently unverifies the
property if it 404s**, which stops search data arriving with no obvious cause. It is one line of
text; keep it.

**Do not put a `.md` file in `docs/public/`.** Markdown anywhere under `docs/` is page source, so a
`docs/public/README.md` renders as `/public/README` *and enters the sitemap* — which is how a
private note ends up submitted to Google. Notes about the site belong in this file, which
`srcExclude` keeps unpublished.

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
domain at step 3 and the pull request at step 4. The site is unreachable in between —
`lintdeveloper.github.io/resilix` 301-redirects to `resilix.js.org`, which serves js.org's wildcard
placeholder until the entry is merged. That gap is the cost of their ordering, and it is smaller
than the cost of arguing with it: the second request,
[#12379](https://github.com/js-org/js.org/pull/12379), did exactly what they asked and merged the
same day.

A trap while waiting: `resilix.js.org` returns **HTTP 200 even before the entry is merged**, because
js.org wildcards `*.js.org` and serves a yellow placeholder. Neither a status code nor a successful
`curl` tells you whether the subdomain is yours. The only reliable check is the entry appearing on
`master`:

```bash
curl -s https://raw.githubusercontent.com/js-org/js.org/master/cnames_active.js | grep '"resilix"'
```

## The cutover — done 2026-08-26

`resilix.js.org` is live: [js-org/js.org#12379](https://github.com/js-org/js.org/pull/12379) merged
and `lintdeveloper.github.io/resilix` now 301-redirects to it. This is kept as a record, because
the same five steps apply to any future move — to `resilix.dev`, for instance.

1. **Set the custom domain** on the Pages config. An artifact `CNAME` file is ignored when
   publishing via a workflow, so it must be set on the repo:

   ```bash
   gh api -X PUT repos/lintdeveloper/resilix/pages -f cname=resilix.js.org
   ```

   Or Settings → Pages → Custom domain. Expect a DNS-check warning until the entry is merged;
   that is correct, not a mistake.

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

## HTTPS: do not wait for a GitHub certificate

**"Enforce HTTPS" is permanently unavailable for a js.org subdomain, and that is fine.** An earlier
version of this page said HTTPS would fail until GitHub issued a certificate and to enable
enforcement "once it does". That instruction can never be followed, and following it wastes time
looking for a certificate that will never appear.

js.org runs its subdomains through **Cloudflare**, which terminates TLS itself:

```
$ dig +short resilix.js.org
104.26.8.84  104.26.9.84  172.67.73.64      ← Cloudflare, not GitHub Pages

$ curl -sI https://resilix.js.org/ | grep -i '^server\|cf-ray'
server: cloudflare
cf-ray: a31a78d62925bb01-AMS
```

GitHub therefore cannot complete an ACME challenge for the hostname, and the API says so plainly:

```
$ gh api -X PUT repos/lintdeveloper/resilix/pages -F https_enforced=true
The certificate does not exist yet (HTTP 404)
```

HTTPS already works, served by Cloudflare rather than by GitHub. `https_enforced` stays `false`.

The one visible consequence: `lintdeveloper.github.io/resilix` 301s to `http://resilix.js.org`,
which then upgrades to HTTPS. Cosmetic, and not fixable from this side.

**This does not apply to a domain you own.** On `resilix.dev` with DNS pointed straight at GitHub's
A/AAAA records, GitHub does issue a certificate, and enforcement should then be switched on. If you
put such a domain behind Cloudflare's proxy, set those records to **DNS only** (grey cloud) until
the certificate issues — an orange-cloud proxy is the most common reason Pages certificate
provisioning never completes.

## It is free, but it is not ownership

The request was accepted, and that is not the same as owning the name. Their
[naming-conflict policy](https://github.com/js-org/js.org/wiki/Naming-Conflicts) breaks ties on
GitHub stars after a three-month grace period. `resilix.dev` is unregistered (~$14/yr) and is the
only route that actually locks the name down. The steps above are identical for it, minus the PR
and plus two DNS records — and because you control the DNS, there is no review window and no
outage.
