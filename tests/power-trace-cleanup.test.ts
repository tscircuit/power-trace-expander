import { expect, test } from "bun:test";
import "bun-match-svg";
import "graphics-debug/matcher";
import { cleanupCases } from "../fixtures/cleanup-cases";
import { PowerTraceCleanupSolver, SpatialObstacleIndex } from "../src";
import { countNonOctilinearSegments } from "../src/octilinear";

test("removes a redundant same-layer via pair", async () => {
  const problem = structuredClone(cleanupCases.viaPairElimination);
  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: problem,
    traces: problem.traces,
  });

  solver.solve();

  const output = solver.getOutput();
  expect(solver.solved).toBe(true);
  expect(
    output[0]!.route.filter((point) => point.route_type === "via"),
  ).toHaveLength(0);
  expect(solver.stats.viaPairCountRemoved).toBe(1);
  expect(solver.stats.viaCountRemoved).toBe(2);
  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path, {
    svgName: "via-pair-elimination",
  });
});

test("uses an octilinear obstacle-aware detour to remove a via pair", async () => {
  const problem = structuredClone(cleanupCases.viaPairObstacleDetour);
  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: problem,
    traces: problem.traces,
  });

  solver.solve();

  const output = solver.getOutput();
  const powerWires = output[0]!.route.filter(
    (point) => point.route_type === "wire",
  );
  expect(solver.solved).toBe(true);
  expect(
    output[0]!.route.filter((point) => point.route_type === "via"),
  ).toHaveLength(0);
  expect(countNonOctilinearSegments(powerWires)).toBe(0);
  expect(solver.stats.attemptedViaGridCount).toBeGreaterThan(0);
  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path, {
    svgName: "via-pair-obstacle-detour",
  });
});

test("shoves a signal to add clearance before octilinear simplification", async () => {
  const problem = structuredClone(cleanupCases.clearanceShoveSimplification);
  const beforeSignal = structuredClone(problem.traces[1]!.route);
  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: problem,
    traces: problem.traces,
  });

  solver.solve();

  const output = solver.getOutput();
  const powerWires = output[0]!.route.filter(
    (point) => point.route_type === "wire",
  );
  expect(solver.solved).toBe(true);
  expect(countNonOctilinearSegments(powerWires)).toBe(0);
  expect(output[1]!.route).not.toEqual(beforeSignal);
  expect(solver.stats.committedClearanceShoveCount).toBeGreaterThan(0);
  expect(solver.stats.achievedExtraClearanceCount).toBeGreaterThan(0);

  const index = new SpatialObstacleIndex(problem, output, 0);
  for (let routeIndex = 0; routeIndex < powerWires.length - 1; routeIndex++) {
    const start = powerWires[routeIndex]!;
    const end = powerWires[routeIndex + 1]!;
    expect(
      index.collides({
        start,
        end,
        layer: start.layer,
        width: start.width,
        connectionNames: ["POWER"],
        ignoreTraceIndex: 0,
      }),
    ).toBe(false);
  }
  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path, {
    svgName: "clearance-shove-simplification",
  });
});
