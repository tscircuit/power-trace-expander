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

Selected traces are stably ordered by nominal width times conservative copper
deficit, so long, badly necked power paths get first choice of scarce wide
corridors. On boards with at least two layers, a remaining segment below half
nominal width also gets a bounded multilayer attempt. The solver searches the
farthest useful interval within 10 mm, carries nominal copper across board
layers with one or two vias, and accepts only a conservative deficit reduction
of at least 0.05 mm² or 10%, without adding more than 10 mm of route.

Multilayer A* tries independent endpoint necks on two offset grids first, using
a quadratic thin-copper penalty. It then tries balanced necks at the same
offsets with a linear penalty and width-preserving simplification. Endpoint
capacity is binary-probed at 0.025 mm increments, and neck length is capped
between 1.5 and 3 mm. This localizes unavoidable thin copper to the pad escape
instead of painting an entire reroute with the endpoint width.

When a power corridor is blocked only by one or two lower-width traces, the
solver first applies a smooth local inflation force to push those traces by the
minimum useful amount. It keeps pads, vias, and anchors fixed and validates each
relaxation against the spatial obstacle index. If the elastic candidate fails,
it falls back to obstacle-aware grid routing within the same 10 mm window. Each
corridor scan, relaxation, validation, grid expansion, and accepted displacement
is exposed as a solver step for debugging.

During a multilayer search, lower-priority traces are treated as soft geometry.
The candidate is then revalidated against the real board and may push at most
two blockers through the same local inflation solver before final acceptance.

Connected copper is resolved across connection names, source-trace IDs, merged
names, route endpoints, and PCB-port IDs. Pads, vias, and traces on the same net
therefore form one copper-clearance region, while different-net copper still
receives the configured clearance. New vias are checked on every board copper
layer, and mechanical drill-edge spacing is enforced even for same-net vias and
fixed vias outside the replaced interval. This matches `@tscircuit/checks`
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
less than 0.1% of the total nominal copper area, with a four-pass hard cap.
This lets displaced traces unlock later improvements without turning a
post-route repair into an unbounded global reroute.

For focused debugging, `onlyConnectionNames` restricts the top-level scan while
retaining the complete board as fixed or pushable context:

```ts
const solver = new PowerTraceExpanderSolver(problem, {
  onlyConnectionNames: ["source_trace_146"],
})
```

`PowerTraceExpanderOptions` and `LayerAwareGridRouteSolver` are exported for
custom integrations and step-level debugger fixtures.

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
- a top-layer wall crossing that requires two vias, nominal bottom copper, and
  localized endpoint necks
- same-net trace, via, pad, and imported-subcircuit alias handling, including
  same-net drill-spacing enforcement
- an isolated upper `P_MOTOR_A` solve with the complete board context retained
- the captured RP2040 Dual Motor SRJ production problem

On the production fixture, a representative local run completes in about 7.3
seconds. It stops after three passes when the final pass adds only 0.0025% of the
nominal copper area, below the 0.1% plateau threshold. The 1 mm routes improve
as follows using Circuit JSON's physical first-route-point segment-width
semantics:

| Metric | Before | After |
| --- | ---: | ---: |
| Full-width coverage | 1.27% | 86.58% |
| At least 0.5 mm coverage | 18.13% | 93.40% |
| Length-weighted average width | 0.232 mm | 0.939 mm |
| 5th percentile width | 0.150 mm | 0.375 mm |
| 10th percentile width | 0.150 mm | 0.750 mm |
| Normalized width deficit | 76.76% | 6.05% |

The stricter endpoint-minimum lower bound reports 85.41% full-width coverage, a
0.936 mm average, and a 6.44% normalized deficit. The 0.25 mm logic-route
full-width coverage rises from 41.12% to 99.38%, while 1 mm route length grows
by 7.83%. A representative run uses about 1.03M solver steps, 8,121 planar-grid
attempts, and 47 layer-grid attempts. The production regression caps wall time,
iterations, and both grid counters so a quality gain cannot hide a major
performance regression.

The full-context focused fixture for upper `P_MOTOR_A` (`AOUT2` to pin 2)
improves from 0% to 99.52% conservative full-width coverage and reaches a 0.998
mm average. It uses exactly two vias and 10.129 mm of bottom copper, leaving a
0.600 mm minimum terminal neck; one neighboring signal is pushed to open that
corridor. The selected solve completes in roughly 0.2 seconds.

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
A* planar/via expansions can all be stepped independently. The deployed catalog
contains six **Simple** cases, including layer-change necking, and three
**Complex** cases: narrow-channel retreat, isolated upper `P_MOTOR_A`, and the
full RP2040 Dual Motor SRJ. Completed views use green/red for nominal/under-width
top copper, blue/purple for bottom copper, orange for the active segment, and
gold circles for vias.
