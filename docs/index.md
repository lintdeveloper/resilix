---
layout: home
hero:
  name: resilix
  text: Load limiting for JavaScript
  tagline: >-
    A dependency that has slowed to a crawl is still "up". resilix measures latency, works out how
    much concurrency your upstream can actually absorb, and sheds the rest — before the errors
    start. Zero dependencies, no I/O.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Why it exists
      link: /guide/
    - theme: alt
      text: GitHub
      link: https://github.com/lintdeveloper/resilix
features:
  - title: Trips on slow, not just broken
    details: >-
      An upstream that degrades from p50 0.35s to p50 10.4s with a flat error rate is invisible to
      a failure-rate breaker. resilix trips on slow-call rate — a dimension no other JavaScript
      breaker has.
    link: /guide/breaker
    linkText: Three trip conditions
  - title: Adaptive concurrency limiting
    details: >-
      Works out how many concurrent calls your upstream can absorb, from latency alone, and sheds
      the excess proportionally. Vegas queue estimation over an O(1) P² quantile estimator.
    link: /guide/limiter
    linkText: How it adapts
  - title: Verdicts, not booleans
    details: >-
      "Did the promise reject?" cannot express that a 404 is healthy and a 429 is backpressure.
      Six verdicts, one settled call, read differently by each policy.
    link: /guide/verdicts
    linkText: The verdict model
  - title: Hedging and retry budgets
    details: >-
      Both previously locked inside @grpc/grpc-js and the AWS SDK. Hedge at the measured p95, cap
      retry amplification at 1.1x, shed low-criticality work first.
    link: /guide/hedging
    linkText: Hedging and criticality
  - title: One line from opossum
    details: >-
      The compatibility shim passes 362 of 362 of opossum's own test suite, run unmodified.
      Default behaviour stays opossum's, so swapping the import changes nothing on day one.
    link: /guide/opossum
    linkText: Migration guide
  - title: Runs everywhere, proven in CI
    details: >-
      Node 18/20/22/24, Bun, Deno and Cloudflare Workers — verified every push by importing the
      built artifact and driving a real breaker, not asserted in a README.
    link: /guide/#design-commitments
    linkText: Design commitments
---
