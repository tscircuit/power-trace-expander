# MangoPi R3C power-expansion disconnection reproduction

`powerTraceExpansionSolver_input.json` is the unmodified constructor tuple
downloaded from the Pipeline 9 debugger immediately before the MangoPi R3C
power-expansion stage:

1. `PowerTraceExpanderInput`
2. `PowerTraceExpanderOptions`

SHA-256:

```text
b5aebe80b7a7a80ee0c26f5aa5cd7585fcb8aae44e8f8bfb6f19420ad878ff93
```

The captured input contains 113 connections, 518 original endpoints, 405 trace
records, 519 via occurrences, six copper layers, two differential-pair records,
and 20 selected power connections. `allowNewVias` is `false`.

At revision `8dd76ba8421e92c2286e8196bcc57e3d3b5871f1`, the solver completes in
7,374,246 iterations with `resultStatus: "best_effort"` and
`completionReason: "expansion_budget"`. Physical-copper validation drops from
502/518 connected original endpoints before expansion to 408/518 afterward.
GND drops from 95/99 to 1/99 connected endpoints.

This fixture is reproduction-only. The emitted route is invalid and is not
fabrication-ready.
