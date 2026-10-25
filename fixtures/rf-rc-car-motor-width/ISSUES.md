# P1: RF RC car left-motor copper remains narrow after expansion

The original routed receiver PCB visibly narrows the two tracks from U2 (L293D)
to JML, while the equivalent JMR motor tracks remain broad. All four motor paths
request 1 mm copper. This issue concerns sustained motor-track width rather than
clearance. See the original [full-board router reproduction PR](https://github.com/tscircuit/tscircuit-autorouter/pull/3271).

## Full-board reproduction

[`input.json`](input.json) is the unchanged power-expansion stage input captured
from that receiver: a 74 × 52 mm, two-layer board with all 15 original connections,
63 obstacles and 46 routed traces. Nothing was cropped, replaced or rerouted in
the fixture. The test uses this package's `PowerTraceExpanderInput` contract and
runs `PowerTraceExpanderSolver(input, { allowNewVias: false })`, matching the
consumer's restriction on new vias.

Run `bun test tests/rf-rc-car-motor-width.test.ts --timeout 9999999`. The test
deliberately preserves the current bug and the solver's native
[full-board snapshot](../../tests/__snapshots__/rf-rc-car-motor-width.snap.svg).

| Connection | Motor path | Nominal width | Minimum output width |
| --- | --- | ---: | ---: |
| `source_trace_42` | U2.OUT_L1 → JML.1 | 1 mm | **0.15 mm** |
| `source_trace_43` | U2.OUT_L2 → JML.2 | 1 mm | **0.30 mm** |
| `source_trace_44` | U2.OUT_R1 → JMR.1 | 1 mm | 1 mm |
| `source_trace_45` | U2.OUT_R2 → JMR.2 | 1 mm | 1 mm |

The solver reports success while leaving these narrow left-motor sections.
Motor current passes through them; equal-thickness 0.15 mm copper has 6.67 times
the resistance per unit length of 1 mm copper. Hardware has not been tested.

## Contract and expected improvement

The original TSX requested `thickness="1mm"`, and source Circuit JSON recorded
`min_trace_thickness: 1`. At this stage each motor connection instead carries
`nominalTraceWidth: 1` and `width: 1`; the global `minTraceWidth` is 0.15 mm. The
fixture therefore demonstrates failure to achieve the intended nominal width,
not violation of a per-connection SRJ hard minimum. Legitimate pad escapes and
genuinely blocked corridors may still require narrower copper.

A fix should improve actual copper geometry in this complete obstacle field,
retain connectivity and the two full-width right-motor controls, and respect
`allowNewVias: false`. The stacked fix should replace the current narrowing
assertions with its improved routing expectations and update the native snapshot.
This report makes no clean-DRC or fabrication-ready claim.
