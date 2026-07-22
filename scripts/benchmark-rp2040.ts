import type { SimpleRouteJson } from "@tscircuit/core";
import rp2040DualMotorProblem from "../fixtures/rp2040-dual-motor/input.json";
import { measureTraceWidths, PowerTraceExpanderSolver } from "../src";

const problem = structuredClone(
  rp2040DualMotorProblem,
) as unknown as SimpleRouteJson;
const before = measureTraceWidths(problem, problem.traces ?? []);
const conservativeBefore = measureTraceWidths(problem, problem.traces ?? [], {
  segmentWidthSemantics: "endpoint-minimum",
});
const solver = new PowerTraceExpanderSolver(problem);
const startTime = performance.now();

solver.solve();

if (!solver.solved || solver.failed) {
  throw new Error(
    `Solver did not complete: ${solver.error ?? JSON.stringify(solver.stats)}`,
  );
}

const runtimeMs = performance.now() - startTime;
const after = measureTraceWidths(problem, solver.getOutput());
const conservativeAfter = measureTraceWidths(problem, solver.getOutput(), {
  segmentWidthSemantics: "endpoint-minimum",
});
const padClearanceViolations = {
  beforeCleanup: solver.initialPadClearanceViolationCountByClearance,
  afterCleanup: solver.remainingPadClearanceViolationCountByClearance,
};
const improvement = Object.fromEntries(
  [...after].map(([nominalWidth, afterMetric]) => {
    const beforeMetric = before.get(nominalWidth)!;
    return [
      nominalWidth,
      {
        nominalCoverageDelta:
          afterMetric.nominalCoverage - beforeMetric.nominalCoverage,
        averageWidthDelta: afterMetric.averageWidth - beforeMetric.averageWidth,
        normalizedWidthDeficitReduction:
          beforeMetric.normalizedWidthDeficit -
          afterMetric.normalizedWidthDeficit,
        routeLengthIncrease:
          afterMetric.totalLength / beforeMetric.totalLength - 1,
      },
    ];
  }),
);

console.log(
  JSON.stringify(
    {
      runtimeMs,
      iterations: solver.iterations,
      stats: solver.stats,
      before: Object.fromEntries(before),
      after: Object.fromEntries(after),
      conservativeEndpointMinimum: {
        before: Object.fromEntries(conservativeBefore),
        after: Object.fromEntries(conservativeAfter),
      },
      padClearanceViolations,
      improvement,
    },
    null,
    2,
  ),
);
