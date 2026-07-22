# @tscircuit/power-trace-expander

Obstacle-aware post-routing solver that expands PCB traces toward their nominal
widths while preserving collision clearances.

[Open the step-through solver debugger](https://power-trace-expander.vercel.app)

The solver keeps already-conforming traces byte-for-byte. For an under-width
trace it evaluates short route intervals, widens clear geometry in place, and
uses a granular high-density grid solver to bypass blocked intervals. Candidate
widths are evaluated from largest to smallest with multiple grid resolutions
and offsets. A successful route is then probed and quantized to the widest safe
intermediate width instead of falling back to only a few coarse widths.

When a power corridor is blocked only by one or two lower-width traces, the
solver first applies a smooth local inflation force to push those traces by the
minimum useful amount. It keeps pads, vias, and anchors fixed and validates each
relaxation against the spatial obstacle index. If the elastic candidate fails,
it falls back to obstacle-aware grid routing within the same 10 mm window. Each
corridor scan, relaxation, validation, grid expansion, and accepted displacement
is exposed as a solver step for debugging.

Connected copper is resolved across connection names, source-trace IDs, merged
names, route endpoints, and PCB-port IDs. Pads, vias, and traces on the same net
therefore form one obstacle-free routing region, while different-net copper
still receives the configured clearance. This matches `@tscircuit/checks`
semantics even when imported subcircuits use different aliases for the same
board-level net.

Preserved child-subcircuit routes that have no connection in the current SRJ
are retained unchanged and remain indexed as obstacles. The actively-mutating
trace is excluded from the immutable Flatbush cache, avoiding stale route-point
indices after splitting or splicing. Flatbush provides the broad phase using
short AABBs for diagonal segments; exact capsule, polygon, and circle tests
provide the narrow phase. Collision queries exit on the first hit and an A*
search maintains its closed-cell count incrementally to avoid board-sized work
inside individual solver steps.

Port aliases are used to recognize same-net copper for clearance, but an
otherwise-unmatched child route does not inherit a board-level connection's
nominal width. This keeps imported internal routing byte-for-byte while still
allowing a connected board trace to enter its pads, vias, and boundary copper.

The solver automatically repeats productive passes and stops when a pass adds
less than 0.1% of the current nominal copper area, with a four-pass hard cap.
This lets displaced traces unlock later improvements without turning a
post-route repair into an unbounded global reroute.

## Regression cases

The committed SVG suite covers:

- clear straight and 45-degree traces
- a central obstacle detour
- retreating to a safe anchor before bypassing a narrow channel
- a detour whose new path is longer than 10 mm while the replaced original
  interval remains within the 10 mm cap
- rotated-obstacle approximation with short AABBs
- a constrained channel that can accept an intermediate, but not nominal, width
- a power trace expanding around a neighboring signal trace
- a straight power trace elastically pushing a neighboring signal trace
- same-net trace, via, pad, and imported-subcircuit alias handling
- the captured RP2040 Dual Motor SRJ production problem

On the production fixture, a representative local run completes in about 9.5
seconds. It stops after three passes when the final pass adds only 0.013% of the
nominal copper area, below the 0.1% plateau threshold. The 1 mm routes improve
as follows using Circuit JSON's physical first-route-point segment-width
semantics:

| Metric | Before | After |
| --- | ---: | ---: |
| Full-width coverage | 1.27% | 80.02% |
| At least 0.5 mm coverage | 18.13% | 92.07% |
| Length-weighted average width | 0.232 mm | 0.906 mm |
| 5th percentile width | 0.150 mm | 0.350 mm |
| 10th percentile width | 0.150 mm | 0.500 mm |
| Normalized width deficit | 76.76% | 9.41% |

The stricter endpoint-minimum lower bound still reports 78.06% full-width
coverage and a 0.897 mm average. The 0.25 mm logic-route full-width coverage
rises from 41.12% to 99.47%. The 1 mm route length grows by 5.73%. The
production regression test caps wall time, iterations, and attempted grids so a
quality gain cannot hide a major performance regression.

## Development

```sh
bun install
bun test
bun run typecheck
bun run benchmark:rp2040
bun run analyze:rp2040
bun run solver:debug
```

The Cosmos debugger uses `GenericSolverDebugger` from
`@tscircuit/solver-utils`; scans, width checks, candidate setup, and individual
A* expansions can all be stepped independently. The deployed catalog groups
straight widening, central and rotated obstacles, constrained intermediate
widths, and local trace inflation under **Simple**, with a narrow-channel
retreat and the full RP2040 Dual Motor SRJ under **Complex**.
