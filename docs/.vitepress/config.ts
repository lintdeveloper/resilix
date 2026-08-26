import { defineConfig } from "vitepress";

// The one place the public URL is written. Everything below derives from these two, because the
// last cutover had the hostname hardcoded in eleven files across four formats.
//
// `base` is "/" because the site is served from the root of a custom domain. On a project page
// (lintdeveloper.github.io/resilix) it has to be "/resilix/" instead, or every asset 404s —
// that is the classic GitHub Pages failure, and it flips with the domain, never separately.
const SITE = "https://resilix.js.org";
const base = "/";

export default defineConfig({
  base,
  lang: "en-GB",
  title: "resilix",
  description:
    "Load limiting for JavaScript: adaptive concurrency limiting and slow-call circuit breaking. Sheds load when an upstream slows, not just when it errors.",
  cleanUrls: true,

  // Operational notes for this repo, not documentation for users of the library. It lives in
  // docs/ because that is where it is looked for, but it must not become a published page.
  srcExclude: ["DEPLOYING.md"],

  // Without this there is no sitemap.xml at all, so the only way in is a crawler following
  // links from the README. Cheap, and the difference between indexed and invisible.
  sitemap: { hostname: `${SITE}${base}` },

  // A broken link is a build failure, not a warning. Most of this site is assembled by
  // including regions of the root README, and a moved heading would otherwise rot silently.
  // This catches missing PAGES only, not missing #anchors — `pnpm docs:check` does those.
  ignoreDeadLinks: false,

  markdown: {
    anchor: {
      // ADR headings read "ADR-007 · Our own rejections are never upstream evidence", which
      // slugifies to a 60-character URL containing a raw `·` and breaks the moment anyone
      // rewords the title. These anchors are cited from source comments and from other pages,
      // so they are pinned to the number, which is the part that never changes.
      slugify: (str: string) => {
        const adr = /^\s*ADR-(\d+)/.exec(str);
        if (adr) return `adr-${adr[1]}`;
        return encodeURIComponent(
          String(str)
            .trim()
            .replace(/[\s#$&+,/:;=?@[\]^`{|}~"'()!*<>\\.]+/g, "-")
            .replace(/-{2,}/g, "-")
            .replace(/^-|-$/g, "")
            .toLowerCase(),
        );
      },
    },
  },

  head: [
    ["link", { rel: "icon", href: `${base}favicon.svg`, type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#3b6fd4" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:url", content: `${SITE}${base}` }],
    ["meta", { property: "og:image", content: `${SITE}${base}og.png` }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    // X/Twitter ignores og:image without a card type, and does not render SVG — hence a PNG,
    // regenerated from scripts/og-card.html with headless Chrome.
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: "resilix — load limiting for JavaScript" }],
    ["meta", { name: "twitter:image", content: `${SITE}${base}og.png` }],
    ["meta", { property: "og:title", content: "resilix — load limiting for JavaScript" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          'A dependency that has slowed to a crawl is still "up". resilix sheds load from latency — adaptive concurrency limiting, slow-call circuit breaking, hedging and retry budgets. Zero dependencies.',
      },
    ],
  ],

  themeConfig: {
    siteTitle: "resilix",
    outline: [2, 3],

    nav: [
      { text: "Guide", link: "/guide/", activeMatch: "/guide/" },
      { text: "Decisions", link: "/decisions", activeMatch: "/decisions" },
      { text: "Specs", link: "/specs/", activeMatch: "/specs/" },
      { text: "Roadmap", link: "/guide/roadmap" },
      {
        text: "npm",
        link: "https://www.npmjs.com/package/resilix",
      },
    ],

    sidebar: {
      "/": [
        {
          text: "Introduction",
          items: [
            { text: "What resilix is", link: "/guide/" },
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "The verdict model", link: "/guide/verdicts" },
          ],
        },
        {
          text: "Policies",
          items: [
            { text: "Circuit breaker", link: "/guide/breaker" },
            { text: "Adaptive limiter", link: "/guide/limiter" },
            { text: "Retry, budgets, throttling", link: "/guide/retry" },
            { text: "Hedging, criticality, fairness", link: "/guide/hedging" },
          ],
        },
        {
          text: "Integrating",
          items: [
            { text: "Driving policies by hand", link: "/guide/manual-control" },
            { text: "Reading the code", link: "/guide/reading-the-code" },
            { text: "Telemetry", link: "/guide/telemetry" },
            { text: "Migrating from opossum", link: "/guide/opossum" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Design decisions", link: "/decisions" },
            { text: "Specs", link: "/specs/" },
            { text: "Roadmap", link: "/guide/roadmap" },
          ],
        },
      ],
    },

    socialLinks: [{ icon: "github", link: "https://github.com/lintdeveloper/resilix" }],

    search: { provider: "local" },

    editLink: {
      pattern: "https://github.com/lintdeveloper/resilix/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "MIT licensed. Zero runtime dependencies.",
      copyright: "© Musa Musa",
    },
  },
});
