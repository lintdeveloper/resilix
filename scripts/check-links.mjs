// Audits the built docs site for broken internal links AND broken #anchors.
//
// VitePress's own dead-link check only validates that a target PAGE exists. It said nothing
// about three links to `#adr-007-our-own-rejections-…`-style anchors that did not exist, which
// is the more likely failure: page paths rarely move, but heading text gets reworded constantly
// and most of this site is assembled by including regions of the root README.
//
// Zero dependencies, same as the library.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const DIST = resolve("docs/.vitepress/dist");
const BASE = "/resilix/";

const walk = (dir) =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".html") ? [p] : [];
  });

const routeOf = (file) =>
  `/${relative(DIST, file)
    .replace(/(index)?\.html$/, "")
    .replace(/\/$/, "")}` || "/";

const pages = walk(DIST);
if (pages.length === 0) {
  console.error("no built pages found — run `pnpm docs:build` first");
  process.exit(1);
}

// route (e.g. "/guide/breaker") -> set of element ids on that page
const ids = new Map();
for (const file of pages) {
  const html = readFileSync(file, "utf8");
  ids.set(routeOf(file), new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
}

const problems = [];
for (const file of pages) {
  const from = routeOf(file);
  // A relative href resolves against the page's DIRECTORY, which is not the same as its route:
  // /guide/index.html has route "/guide" but directory "/guide", so `./verdicts` is
  // /guide/verdicts, not /verdicts. Deriving it from the route instead got all five index-page
  // links wrong.
  const dir = `/${relative(DIST, dirname(file))}`.replace(/\/\.$/, "").replace(/^\/$|^\/\.$/, "/");
  const html = readFileSync(file, "utf8");

  for (const [, href] of html.matchAll(/\shref="([^"]+)"/g)) {
    if (/^(https?:|mailto:|tel:|data:)/.test(href)) continue;
    if (href.startsWith("#")) {
      if (href !== "#" && !ids.get(from)?.has(decodeURIComponent(href.slice(1))))
        problems.push(`${from} → ${href} (no such anchor on this page)`);
      continue;
    }
    // VitePress rewrites only SOME links to absolute `/resilix/...`; the rest stay relative
    // as authored (`./../decisions#adr-007`). An earlier version of this script only handled
    // the absolute form and so silently checked almost nothing — it passed a deliberately
    // broken `#adr-999`. Both forms have to be resolved.
    const [rawHref, hash] = href.split("#");
    const rawPath = rawHref.startsWith(BASE)
      ? rawHref.slice(BASE.length - 1)
      : rawHref.startsWith("/")
        ? rawHref
        : resolve(dir, rawHref);
    const target = rawPath.replace(/\/$/, "") || "/";
    // assets and the PDF are files, not routes
    if (/\.[a-z0-9]+$/i.test(target)) continue;

    if (!ids.has(target)) {
      problems.push(`${from} → ${href} (no such page)`);
    } else if (hash && !ids.get(target).has(decodeURIComponent(hash))) {
      problems.push(`${from} → ${href} (page exists, anchor "#${hash}" does not)`);
    }
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} broken link(s):\n`);
  for (const p of problems) console.error(`   ${p}`);
  process.exit(1);
}
console.log(`✓ ${pages.length} pages, every internal link and anchor resolves`);
