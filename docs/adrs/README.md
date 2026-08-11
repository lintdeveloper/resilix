# ADRs

One file per decision, numbered, never rewritten in place — superseded by a new ADR instead.

Every default in resilix should be traceable to either an ADR or a cited source. If you cannot say
where a number came from, it is a guess and should be labelled as one.

Shape to copy:

```
# ADR-00N: <the decision, as a statement>

## Status
Accepted | Proposed | Superseded by ADR-00M

## Context
What forced a choice. Include real numbers where you have them.

## Decision
What we chose, stated so someone can implement it without asking questions.

## Alternatives rejected
Each one, with WHY. This is the part that has value in two years.

## Consequences
Positive, and the costs we accepted.
```

Backlog, from the architecture PDF §15 — these are decided but not yet written up:

- ADR-001 zero runtime dependencies, no I/O in core
- ADR-002 no distributed or shared policy state, ever, in core
- ADR-003 outcomes are classified into a verdict, not reduced to a boolean
- ADR-004 policies are admit/settle state machines; only the Executor is async
- ADR-005 time is injected via a Clock
- ADR-006 latency is a first-class signal in every policy
- ADR-007 our own rejections are never upstream evidence
- ADR-008 prefer queueing and probabilistic shedding over hard rejection
- ADR-009 ship capabilities from production experience, not our tuning
- ADR-010 telemetry is a non-throwing observer, built in, not a plugin
- ADR-011 one package, many subpath exports
- ADR-012 ship a compatibility shim for the incumbent
- ADR-013 timeout lives in the Executor, not as a Policy  (deviation from the PDF's §5 component list)
- ADR-014 tsconfig uses lib DOM for types only, not @types/node
