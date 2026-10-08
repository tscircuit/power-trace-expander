import { expect, test } from "bun:test";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { PowerTraceExpanderSolver } from "../src";
const testWire = (x: number, y: number, width = 0.15) => ({
  route_type: "wire" as const,
  x,
  y,
  width,
  layer: "top",
});
test("rejects a reroute that removes an interior same-net pad junction", () => {
  const input = structuredClone(simplifiedCases.straightClear);
  input.obstacles = [
    {
      type: "rect",
      obstacleId: "same-net-branch-pad",
      center: { x: 0, y: 1 },
      width: 2,
      height: 1,
      layers: ["top"],
      connectedTo: ["POWER"],
    },
  ];
  input.traces![0]!.route = [
    testWire(-2, 0),
    testWire(-0.5, 0),
    testWire(0, 0.6),
    testWire(0.5, 0),
    testWire(2, 0),
  ];
  const solver = new PowerTraceExpanderSolver(input);
  const internalSolver = solver as unknown as {
    traceIndex: number;
    rebuildObstacleIndex: () => void;
    routeReplacementPreservesSameNetContacts: (
      trace: (typeof solver.traces)[number],
      interval: { startIndex: number; endIndex: number },
      replacement: (typeof solver.traces)[number]["route"],
    ) => boolean;
  };
  internalSolver.traceIndex = 0;
  internalSolver.rebuildObstacleIndex();
  const trace = solver.traces[0]!;

  expect(
    internalSolver.routeReplacementPreservesSameNetContacts(
      trace,
      { startIndex: 1, endIndex: 3 },
      [trace.route[1]!, trace.route[3]!],
    ),
  ).toBe(false);
  expect(
    internalSolver.routeReplacementPreservesSameNetContacts(
      trace,
      { startIndex: 1, endIndex: 3 },
      trace.route.slice(1, 4),
    ),
  ).toBe(true);
});
