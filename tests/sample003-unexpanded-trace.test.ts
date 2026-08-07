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

test("expands the sample003 trace on its existing layer without new vias", async () => {
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
  expect(solver.reroutedSegmentCount).toBeGreaterThan(0);
  expect(targetTrace.route.every((point) => point.route_type === "wire")).toBe(
    true,
  );
  expect(metrics.minimumWidth).toBe(SAMPLE003_NOMINAL_WIDTH);
  expect(metrics.averageWidth).toBe(SAMPLE003_NOMINAL_WIDTH);
  expect(metrics.nominalCoverage).toBe(1);
  expect(metrics.longestBelowHalfNominalRun).toBe(0);

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
      title: "sample003: trace expands on top without new vias",
    }),
  ).toMatchGraphicsSvg(import.meta.path);
});
