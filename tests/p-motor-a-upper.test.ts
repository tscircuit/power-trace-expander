import { expect, test } from "bun:test";
import "bun-match-svg";
import "graphics-debug/matcher";
import {
  createUpperPMotorAProblem,
  UPPER_P_MOTOR_A_CONNECTION,
} from "../fixtures/rp2040-dual-motor/create-upper-p-motor-a-problem";
import { PowerTraceExpanderSolver, SpatialObstacleIndex } from "../src";
import { getTraceWidthMetrics } from "./helpers/getTraceWidthMetrics";

test("isolated upper P_MOTOR_A uses a wide layer-changing escape", async () => {
  const problem = createUpperPMotorAProblem();
  const originalTargetTrace = problem.traces?.find(
    (trace) => trace.connection_name === UPPER_P_MOTOR_A_CONNECTION,
  )!;
  const before = getTraceWidthMetrics(problem, [originalTargetTrace], {
    segmentWidthSemantics: "endpoint-minimum",
  }).get(1)!;
  const solver = new PowerTraceExpanderSolver(problem, {
    onlyConnectionNames: [UPPER_P_MOTOR_A_CONNECTION],
  });
  const startTime = performance.now();

  solver.solve();

  const runtimeMs = performance.now() - startTime;
  const output = solver.getOutput();
  const targetTraceIndex = output.findIndex(
    (trace) => trace.connection_name === UPPER_P_MOTOR_A_CONNECTION,
  );
  const targetTrace = output[targetTraceIndex]!;
  const after = getTraceWidthMetrics(problem, [targetTrace], {
    segmentWidthSemantics: "endpoint-minimum",
  }).get(1)!;
  let bottomLength = 0;
  for (let index = 0; index < targetTrace.route.length - 1; index++) {
    const routeStart = targetTrace.route[index];
    const routeEnd = targetTrace.route[index + 1];
    if (
      routeStart?.route_type === "wire" &&
      routeEnd?.route_type === "wire" &&
      routeStart.layer === "bottom" &&
      routeEnd.layer === "bottom"
    ) {
      bottomLength += Math.hypot(
        routeEnd.x - routeStart.x,
        routeEnd.y - routeStart.y,
      );
    }
  }

  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(before.nominalCoverage).toBe(0);
  // Keeping the layer-change via out of the terminal pad requires a short
  // neck from the pad edge. Nearly all of the route remains nominal-width.
  expect(after.nominalCoverage).toBeGreaterThan(0.97);
  expect(after.averageWidth).toBeGreaterThan(0.99);
  expect(after.normalizedWidthDeficit).toBeLessThan(0.01);
  expect(after.coverageByFraction[0.5]).toBe(1);
  expect(after.totalLength / before.totalLength).toBeLessThan(1.3);
  expect(bottomLength).toBeGreaterThan(10);
  expect(
    targetTrace.route.filter((point) => point.route_type === "via"),
  ).toHaveLength(2);
  expect(solver.layerReroutedTraceCount).toBe(1);
  expect(solver.attemptedLayerGridCount).toBeLessThanOrEqual(2);
  expect(solver.pushedTraceCount).toBeGreaterThanOrEqual(1);
  expect(runtimeMs).toBeLessThan(2_000);

  const validationTraces = output.map((trace, traceIndex) =>
    traceIndex === targetTraceIndex ? { ...trace, route: [] } : trace,
  );
  const obstacleIndex = new SpatialObstacleIndex(problem, validationTraces);
  const connectionNames = [UPPER_P_MOTOR_A_CONNECTION];
  const priorViaPoints: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < targetTrace.route.length; index++) {
    const routePoint = targetTrace.route[index];
    if (routePoint?.route_type === "via") {
      expect(
        obstacleIndex.collidesVia({
          point: routePoint,
          layers: obstacleIndex.boardLayers,
          padDiameter: routePoint.via_diameter ?? 0.6,
          holeDiameter:
            routePoint.via_hole_diameter ??
            obstacleIndex.defaultViaHoleDiameter,
          connectionNames,
          otherNewViaPoints: priorViaPoints,
          blockSameNetObstacles: true,
          sameNetObstacleClearance: 0,
        }),
      ).toBe(false);
      priorViaPoints.push({ x: routePoint.x, y: routePoint.y });
      continue;
    }
    const routeEnd = targetTrace.route[index + 1];
    if (
      routePoint?.route_type === "wire" &&
      routeEnd?.route_type === "wire" &&
      routePoint.layer === routeEnd.layer
    ) {
      expect(
        obstacleIndex.collides({
          start: routePoint,
          end: routeEnd,
          layer: routePoint.layer,
          width: Math.max(routePoint.width, routeEnd.width),
          connectionNames,
        }),
      ).toBe(false);
    }
  }

  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path);
});
