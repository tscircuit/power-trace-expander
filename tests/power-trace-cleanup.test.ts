import { expect, test } from "bun:test";
import "bun-match-svg";
import "graphics-debug/matcher";
import { cleanupCases } from "../fixtures/cleanup-cases";
import { PowerTraceCleanupSolver, SpatialObstacleIndex } from "../src";
import { countNonOctilinearSegments } from "../src/octilinear";

const getRouteVias = (
  route: (typeof cleanupCases.viaPairElimination.traces)[number]["route"],
) => route.filter((point) => point.route_type === "via");

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

test("removes the sample001 via pair beside a Pico pad", async () => {
  const problem = structuredClone(cleanupCases.sample001ViaPairPadDetour);
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
  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path, {
    svgName: "sample001-via-pair-pad-detour",
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

test("relocates a routed via out of a connected pad", async () => {
  const problem = structuredClone(cleanupCases.routedViaInConnectedPad);
  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: problem,
    traces: problem.traces,
  });

  solver.solve();

  const output = solver.getOutput();
  const routeVia = getRouteVias(output[0]!.route)[0]!;
  const index = new SpatialObstacleIndex(problem, output, 0);
  expect(solver.stats.relocatedViaCount).toBe(1);
  expect(
    index.collidesVia({
      point: routeVia,
      layers: index.boardLayers,
      padDiameter: routeVia.via_diameter ?? 0.6,
      holeDiameter: routeVia.via_hole_diameter ?? 0.3,
      connectionNames: ["POWER"],
      ignoreTraceIndex: 0,
      ignoreRouteRange: { start: 1, end: 3 },
      blockSameNetObstacles: true,
      sameNetObstacleClearance: 0,
    }),
  ).toBe(false);
  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path, {
    svgName: "routed-via-in-connected-pad",
  });
});

test("shoves a connectionless local trace to escape a connected pad", async () => {
  const problem = structuredClone(
    cleanupCases.connectedPadViaBehindConnectionlessTrace,
  );
  const beforeBlocker = structuredClone(problem.traces[1]!.route);
  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: problem,
    traces: problem.traces,
  });

  solver.solve();

  const output = solver.getOutput();
  const routeVia = getRouteVias(output[0]!.route)[0]!;
  const index = new SpatialObstacleIndex(problem, output, 0);
  expect(solver.stats.committedPushedViaRepairCount).toBe(1);
  expect(solver.stats.unresolvedViaCount).toBe(0);
  expect(output[1]!.route).not.toEqual(beforeBlocker);
  expect(
    index.collidesVia({
      point: routeVia,
      layers: index.boardLayers,
      padDiameter: routeVia.via_diameter ?? 0.6,
      holeDiameter: routeVia.via_hole_diameter ?? 0.3,
      connectionNames: ["POWER"],
      ignoreTraceIndex: 0,
      ignoreRouteRange: { start: 1, end: 3 },
      blockSameNetObstacles: true,
      sameNetObstacleClearance: 0,
    }),
  ).toBe(false);
  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path, {
    svgName: "connectionless-local-trace-via-shove",
  });
});

test("separates clustered same-net routed vias", async () => {
  const problem = structuredClone(cleanupCases.clusteredSameNetVias);
  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: problem,
    traces: problem.traces,
  });

  solver.solve();

  const vias = solver.getOutput().flatMap((trace) => getRouteVias(trace.route));
  expect(vias).toHaveLength(2);
  expect(
    Math.hypot(vias[0]!.x - vias[1]!.x, vias[0]!.y - vias[1]!.y),
  ).toBeGreaterThanOrEqual(0.4 - 1e-9);
  expect(solver.stats.relocatedViaCount).toBeGreaterThanOrEqual(1);
  expect(solver.stats.unresolvedViaCount).toBe(0);
  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path, {
    svgName: "clustered-same-net-vias",
  });
});

test("reroutes a power trace to its preferred pad clearance", async () => {
  const problem = structuredClone(cleanupCases.powerTracePadClearance);
  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: problem,
    traces: problem.traces,
  });

  solver.solve();

  const output = solver.getOutput();
  const index = new SpatialObstacleIndex(problem, output, 0);
  const route = output[0]!.route;
  const powerWires = route.filter((point) => point.route_type === "wire");
  for (let routeIndex = 0; routeIndex < route.length - 1; routeIndex++) {
    const start = route[routeIndex];
    const end = route[routeIndex + 1];
    if (
      start?.route_type !== "wire" ||
      end?.route_type !== "wire" ||
      start.layer !== end.layer
    ) {
      continue;
    }
    expect(
      index.collides({
        start,
        end,
        layer: start.layer,
        width: Math.max(start.width, end.width),
        connectionNames: ["POWER"],
        ignoreTraceIndex: 0,
        // The default preferred clearance is half the 0.8 mm nominal width.
        obstacleClearance: 0.4,
      }),
    ).toBe(false);
  }
  expect(countNonOctilinearSegments(powerWires)).toBe(0);
  expect(solver.stats.padClearanceRerouteCount).toBeGreaterThanOrEqual(1);
  expect(solver.stats.unresolvedPadClearanceCount).toBe(0);
  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path, {
    svgName: "power-trace-pad-clearance",
  });
});

test("keeps a partial pad-clearance improvement when half-width is blocked", async () => {
  const problem = structuredClone(cleanupCases.constrainedPadClearance);
  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: problem,
    traces: problem.traces,
  });

  solver.solve();

  const output = solver.getOutput();
  const index = new SpatialObstacleIndex(problem, output, 0);
  const powerWires = output[0]!.route.filter(
    (point) => point.route_type === "wire",
  );
  const collidesAtClearance = (obstacleClearance: number) =>
    powerWires.slice(0, -1).some((start, routeIndex) => {
      const end = powerWires[routeIndex + 1]!;
      return index.collides({
        start,
        end,
        layer: start.layer,
        width: Math.max(start.width, end.width),
        connectionNames: ["POWER"],
        ignoreTraceIndex: 0,
        obstacleClearance,
      });
    });

  expect(collidesAtClearance(0.2)).toBe(false);
  expect(collidesAtClearance(0.25)).toBe(true);
  expect(countNonOctilinearSegments(powerWires)).toBe(0);
  expect(solver.stats.padClearanceRerouteCount).toBeGreaterThanOrEqual(1);
  await expect(solver.visualize()).toMatchGraphicsSvg(import.meta.path, {
    svgName: "constrained-pad-clearance",
  });
});
