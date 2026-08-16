# Deploying the docs site

The site is built by `.github/workflows/docs.yml` on every push to `main` and deployed to GitHub
Pages. Pull requests build and audit it but never deploy — a fork PR must not be able to publish.

Locally: `pnpm docs:dev` to work on it, `pnpm docs:check` to build it and audit every internal
link and `#anchor` the way CI does.

## Moving to resilix.js.org

`resilix.github.io` is not obtainable — that hostname comes from a GitHub *account* name, and
`github.com/Resilix` is already taken by a dormant account (created Aug 2023, no repos). GitHub
does not release inactive usernames. So the project-branded URL is a js.org subdomain:
[js-org/js.org#12312](https://github.com/js-org/js.org/pull/12312) requests `resilix.js.org`.

**Do not do any of this before that PR merges.** Setting a custom domain makes GitHub Pages
301-redirect `lintdeveloper.github.io/resilix` to a hostname that does not resolve yet, and
js.org's single most common rejection reason is a reviewer finding no content on the page.

When it merges, in this order:

1. **Point the repo at the hostname.** An artifact `CNAME` file is ignored when publishing via a
   workflow, so it has to be set on the Pages config:

   ```bash
   gh api -X PUT repos/lintdeveloper/resilix/pages -f cname=resilix.js.org
   ```

2. **Flip the base path** in `docs/.vitepress/config.ts` — `const base = "/"`. An apex custom
   domain serves from the root, so leaving it as `/resilix/` 404s every asset.

3. **Update the two links in `README.md`** (the badge line near the top and the Documentation
   section) and this file.

4. **Verify, do not assume.** DNS can take up to 24 hours:

   ```bash
   curl -sI https://resilix.js.org/ | head -1
   curl -s https://resilix.js.org/ | grep -c 'href="/assets'   # assets at root, not /resilix/
   ```

   Until the certificate is issued, HTTPS will fail while HTTP works — that is normal and
   resolves itself. Enforce HTTPS in the Pages settings once it does.

## If the subdomain is ever reassigned

js.org's [naming-conflict policy](https://github.com/js-org/js.org/wiki/Naming-Conflicts) breaks
ties on GitHub stars with a three-month grace period. It is free and has happened roughly once in
three years, but it is not ownership. `resilix.dev` is unregistered and is the only route that
actually locks the name down; the steps above are identical for it, minus the js.org PR and plus
two DNS records.
