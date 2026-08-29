---
description: "Drive resilix policies by hand with gate(). Every policy is a synchronous state machine, so it works from a stream consumer or a queue worker."
---

# Driving policies by hand

<!--@include: ../../README.md#manual-->

## Why this is possible at all

A resilix policy is four *synchronous* methods — `admit`, `settle`, `stats`, `snapshot`. Only the
executor knows about promises. That is what makes `gate()` a first-class way to use the library
rather than an escape hatch, and it is why a policy decision is allocation-free on the hot path.

The reasoning, and what it costs, is in
[ADR-004](../decisions#adr-004).
