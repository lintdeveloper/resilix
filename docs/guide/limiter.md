---
description: "Adaptive concurrency limiting for JavaScript: Vegas queue estimation over an O(1) P² quantile estimator, shedding load proportionally rather than at a cliff."
---

# Adaptive concurrency limiting

<!--@include: ../../README.md#limiter-->

## Going deeper

The full design — Vegas queue estimation, the P² quantile estimator, the baseline problem, and
the provenance of every default — is in
[the adaptive limiter spec](../specs/adaptive-limiter).
