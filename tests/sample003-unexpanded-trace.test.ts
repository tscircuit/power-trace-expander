import { expect, setDefaultTimeout, test } from "bun:test";
import "graphics-debug/matcher";
import {
  createSample003UnexpandedTraceProblem,
  SAMPLE003_AVAILABLE_TOP_ROUTE,
  SAMPLE003_NOMINAL_WIDTH,
  SAMPLE003_TARGET_CONNECTION,
  SAMPLE003_TARGET_TRACE_ID,
} from "../fixtures/sample003-unexpanded-trace/createSample003UnexpandedTraceProblem";
import { getPowerTraceGraphics } from "../fixtures/getPowerTraceGraphics";
import {
  measureTraceWidths,
  PowerTraceExpanderSolver,
  SpatialObstacleIndex,
} from "../src";

setDefaultTimeout(60_000);

test("reproduces the sample003 trace left below half nominal width", async () => {
  const problem = createSample003UnexpandedTraceProblem();
  const solver = new PowerTraceExpanderSolver(problem, {
    allowNewVias: false,
  });

  solver.solve();

  const targetTrace = solver
    .getOutput()
    .find((trace) => trace.pcb_trace_id === SAMPLE003_TARGET_TRACE_ID);
  if (!targetTrace) {
    throw new Error(`Missing sample003 trace ${SAMPLE003_TARGET_TRACE_ID}`);
  }
  const metrics = measureTraceWidths(problem, [targetTrace]).get(
    SAMPLE003_NOMINAL_WIDTH,
  )!;

  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.insertedViaCount).toBe(0);
  expect(solver.reroutedSegmentCount).toBe(0);
  expect(metrics.minimumWidth).toBe(0.225);
  expect(metrics.averageWidth).toBeLessThan(0.4);
  expect(metrics.longestBelowHalfNominalRun).toBeGreaterThan(18);

  // A full-width, top-only replacement is clear in the same obstacle field,
  // so this is an expansion miss rather than a genuinely blocked corridor.
  const obstacleIndex = new SpatialObstacleIndex(problem, []);
  for (
    let index = 0;
    index < SAMPLE003_AVAILABLE_TOP_ROUTE.length - 1;
    index++
  ) {
    expect(
      obstacleIndex.collides({
        start: SAMPLE003_AVAILABLE_TOP_ROUTE[index]!,
        end: SAMPLE003_AVAILABLE_TOP_ROUTE[index + 1]!,
        layer: "top",
        width: SAMPLE003_NOMINAL_WIDTH,
        connectionNames: [
          SAMPLE003_TARGET_CONNECTION,
          "pcb_port_37",
          "pcb_port_51",
        ],
      }),
    ).toBe(false);
  }

  await expect(
    getPowerTraceGraphics({
      problem,
      traces: [targetTrace],
      title: "sample003: expandable trace remains below half nominal",
    }),
  ).toMatchGraphicsSvg(import.meta.path);
});
