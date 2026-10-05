import { expect, test } from "bun:test";
import { PowerTraceClearanceRepairSolver } from "../src";
import { capturePhysicalConnectivity } from "../src/PhysicalConnectivityInvariant";
import type { PowerTraceExpanderInput } from "../src/types";

const wire = (x: number, y: number, width: number) => ({
  route_type: "wire" as const,
  x,
  y,
  width,
  layer: "top",
});

test("clearance width repair rolls back when it removes an edge junction", () => {
  const problem: PowerTraceExpanderInput = {
    layerCount: 1,
    minTraceWidth: 0.15,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -1, maxY: 2 },
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.8,
        pointsToConnect: [
          { x: -2, y: 0, layer: "top", pointId: "power-left" },
          { x: 2, y: 0, layer: "top", pointId: "power-right" },
          { x: 0, y: 0.9, layer: "top", pointId: "power-branch" },
        ],
      },
      {
        name: "SIGNAL",
        nominalTraceWidth: 0.15,
        pointsToConnect: [
          { x: -2, y: 0.5, layer: "top", pointId: "signal-left" },
          { x: 2, y: 0.5, layer: "top", pointId: "signal-right" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        obstacleId: "power-branch-pad",
        center: { x: 0, y: 0.9 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: ["POWER", "power-branch"],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "power-trunk",
        connection_name: "POWER",
        route: [wire(-2, 0, 0.8), wire(2, 0, 0.8)],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "signal-trunk",
        connection_name: "SIGNAL",
        route: [wire(-2, 0.5, 0.15), wire(2, 0.5, 0.15)],
      },
    ],
  };
  const baselinePartition = capturePhysicalConnectivity(
    problem,
    problem.traces!,
  ).endpointComponents;
  expect(baselinePartition).toContainEqual(["0:0", "0:1", "0:2"]);

  const solver = new PowerTraceClearanceRepairSolver({
    simpleRouteJson: problem,
    traces: problem.traces!,
    traceIndices: [0],
  });
  solver.solve();

  expect(solver.repairedSegmentCount).toBe(0);
  expect(solver.stats).toMatchObject({
    resultStatus: "best_effort",
    completionReason: "connectivity_rollback",
    connectivityRollbackCount: 1,
    connectivityRollbackMutationStats: { repairedSegmentCount: 1 },
  });
  expect(
    capturePhysicalConnectivity(problem, solver.getOutput()).endpointComponents,
  ).toEqual(baselinePartition);
});

test("clearance repair preserves the caller's trace priority", () => {
  const problem: PowerTraceExpanderInput = {
    layerCount: 1,
    minTraceWidth: 0.15,
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    connections: [],
    obstacles: [],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "first",
        route: [wire(-1, 0, 0.2), wire(1, 0, 0.2)],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "second",
        route: [wire(-1, 1, 0.2), wire(1, 1, 0.2)],
      },
    ],
  };
  const solver = new PowerTraceClearanceRepairSolver({
    simpleRouteJson: problem,
    traces: problem.traces ?? [],
    traceIndices: [1, 0, 1],
  });

  expect(solver.stats.traceIndex).toBe(1);
  expect(solver.stats.traceCount).toBe(2);
});

test("clearance output cannot mutate the solver's safe snapshot", () => {
  const problem: PowerTraceExpanderInput = {
    layerCount: 1,
    minTraceWidth: 0.15,
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    connections: [],
    obstacles: [],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "safe",
        route: [wire(-1, 0, 0.2), wire(1, 0, 0.2)],
      },
    ],
  };
  const solver = new PowerTraceClearanceRepairSolver({
    simpleRouteJson: problem,
    traces: problem.traces ?? [],
  });
  solver.solve();

  const firstOutput = solver.getOutput();
  const firstWire = firstOutput[0]?.route[0];
  if (firstWire?.route_type !== "wire") throw new Error("Expected a wire");
  firstWire.x = 42;

  const secondOutput = solver.getOutput();
  expect(secondOutput).not.toBe(firstOutput);
  expect(secondOutput[0]?.route[0]).toMatchObject({ x: -1 });
});
