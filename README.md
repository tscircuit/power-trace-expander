# @tscircuit/power-trace-expander

Obstacle-aware post-routing solver that expands PCB traces toward their nominal
widths while preserving collision clearances.

[Open the step-through solver debugger](https://power-trace-expander.vercel.app)

The solver keeps already-conforming traces byte-for-byte. For an under-width
trace it evaluates short route intervals, widens clear geometry in place, and
uses a granular high-density grid solver to bypass blocked intervals. Candidate
widths are evaluated from largest to smallest with multiple grid resolutions
and offsets, so the first accepted replacement is the widest safe route found.

When a nominal-width power corridor is blocked only by one or two lower-width
traces, the solver can now apply a localized inflation pass before moving the
power trace. It keeps the blocking trace's pads and vias fixed, selects stable
anchors within a 10 mm window, and obstacle-routes the intervening trace around
the inflated corridor. Each corridor scan, anchor selection, grid candidate,
and accepted displacement is exposed as a solver step for debugging.

Preserved child-subcircuit routes that have no connection in the current SRJ
are retained unchanged and remain indexed as obstacles. The actively-mutating
trace is excluded from the immutable Flatbush cache, avoiding stale route-point
indices after splitting or splicing. Other traces, vias, pads, rotated
obstacles, and board bounds continue to participate in clearance checks.

## Regression cases

The committed SVG suite covers:

- clear straight and 45-degree traces
- a central obstacle detour
- retreating to a safe anchor before bypassing a narrow channel
- a detour whose new path is longer than 10 mm while the replaced original
  interval remains within the 10 mm cap
- rotated-obstacle approximation with short AABBs
- a power trace expanding around a neighboring signal trace
- a straight power trace locally pushing a neighboring signal trace
- the captured RP2040 Dual Motor SRJ production problem

On the production fixture, 1 mm trace coverage rises from 1.27% to more than
50%, and length-weighted average width rises from 0.232 mm to more than
0.661 mm. The 0.25 mm trace coverage rises from 41.10% to more than 87%.

## Development

```sh
bun install
bun test
bun run typecheck
bun run solver:debug
```

The Cosmos debugger uses `GenericSolverDebugger` from
`@tscircuit/solver-utils`; scans, width checks, candidate setup, and individual
A* expansions can all be stepped independently. The default fixture shows the
localized trace-inflation case.
