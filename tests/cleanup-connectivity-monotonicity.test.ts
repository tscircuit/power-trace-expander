import { expect, test } from "bun:test";
import { PowerTraceCleanupSolver, PowerTraceExpanderSolver } from "../src";
import { capturePhysicalConnectivity } from "../src/PhysicalConnectivityInvariant";
import type { PowerTraceExpanderInput } from "../src/types";

const wire = (x: number, y: number) => ({
  route_type: "wire" as const,
  x,
  y,
  width: 0.8,
  layer: "top" as const,
});

const createProblem = (): PowerTraceExpanderInput => ({
  layerCount: 1,
  minTraceWidth: 0.15,
  nominalTraceWidth: 0.8,
  defaultObstacleMargin: 0.1,
  minTraceToPadEdgeClearance: 0.1,
  bounds: { minX: -3, maxX: 3, minY: -2, maxY: 2 },
  connections: [
    {
      name: "POWER",
      nominalTraceWidth: 0.8,
      pointsToConnect: [
        {
          x: -2,
          y: 0,
          layer: "top",
          pointId: "terminal-left",
          pcb_port_id: "terminal-left",
        },
        {
          x: 2,
          y: 0,
          layer: "top",
          pointId: "terminal-right",
          pcb_port_id: "terminal-right",
        },
        {
          x: 0,
          y: 1,
          layer: "top",
          pointId: "terminal-branch",
          pcb_port_id: "terminal-branch",
        },
      ],
    },
  ],
  obstacles: [
    {
      type: "rect",
      obstacleId: "branch-pad",
      center: { x: 0, y: 1 },
      width: 2,
      height: 1,
      layers: ["top"],
      connectedTo: ["branch-pad", "terminal-branch", "POWER"],
    },
  ],
  traces: [
    {
      type: "pcb_trace",
      pcb_trace_id: "power-trunk",
      connection_name: "POWER",
      connectsTo: ["terminal-left", "terminal-right"],
      route: [
        wire(-2, 0),
        wire(-0.5, 0),
        wire(0, 0.6),
        wire(0.5, 0),
        wire(2, 0),
      ],
    },
  ],
});

const expectedPartition = [["0:0", "0:1", "0:2"]];

const createOvalPadProblem = (): PowerTraceExpanderInput => ({
  layerCount: 1,
  minTraceWidth: 0.15,
  nominalTraceWidth: 0.8,
  defaultObstacleMargin: 0.1,
  minTraceToPadEdgeClearance: 0.1,
  bounds: { minX: -2, maxX: 4, minY: -2, maxY: 4 },
  connections: [
    {
      name: "POWER",
      nominalTraceWidth: 0.8,
      pointsToConnect: [
        { x: -1, y: 3, layer: "top", pointId: "A" },
        { x: 3, y: -1, layer: "top", pointId: "B" },
        { x: 0, y: 0, layer: "top", pointId: "branch" },
      ],
    },
  ],
  obstacles: [
    {
      type: "oval",
      obstacleId: "round-branch-pad",
      center: { x: 0, y: 0 },
      width: 2,
      height: 2,
      layers: ["top"],
      connectedTo: ["POWER", "branch"],
    },
  ],
  traces: [
    {
      type: "pcb_trace",
      pcb_trace_id: "power-trunk",
      connection_name: "POWER",
      route: [wire(-1, 3), wire(0.6, 0.6), wire(3, -1)],
    },
  ],
});

test("cleanup rolls back a simplification that splits a pad T-junction", () => {
  const inputProblem = createProblem();
  const inputTraces = inputProblem.traces!;
  expect(
    capturePhysicalConnectivity(inputProblem, inputTraces).endpointComponents,
  ).toEqual(expectedPartition);

  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: inputProblem,
    traces: inputTraces,
  });
  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.simplifiedPathCount).toBe(0);
  expect(solver.stats).toMatchObject({
    resultStatus: "best_effort",
    completionReason: "connectivity_rollback",
    connectivityRollbackCount: 1,
    connectivityRollbackMutationStats: { simplifiedPathCount: 1 },
  });
  expect(
    capturePhysicalConnectivity(inputProblem, solver.getOutput())
      .endpointComponents,
  ).toEqual(expectedPartition);
});

test("the full expander emits only its last connectivity-safe checkpoint", () => {
  const inputProblem = createProblem();
  const solver = new PowerTraceExpanderSolver(inputProblem);
  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.stats).toMatchObject({
    resultStatus: "best_effort",
    completionReason: "connectivity_rollback",
    connectivityRollbackCount: 1,
    connectivityRollbackPhases: ["cleanup"],
  });
  expect(
    capturePhysicalConnectivity(inputProblem, solver.getOutput())
      .endpointComponents,
  ).toEqual(expectedPartition);
});

test("the full expander rolls back an oval-pad corner shortcut", () => {
  const inputProblem = createOvalPadProblem();
  const inputTraces = structuredClone(inputProblem.traces!);
  expect(
    capturePhysicalConnectivity(inputProblem, inputTraces).endpointComponents,
  ).toEqual(expectedPartition);

  const solver = new PowerTraceExpanderSolver(inputProblem);
  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.stats).toMatchObject({
    resultStatus: "best_effort",
    completionReason: "connectivity_rollback",
    connectivityRollbackCount: 1,
    connectivityRollbackPhases: ["cleanup"],
  });
  expect(solver.getOutput()).toEqual(inputTraces);
  expect(
    capturePhysicalConnectivity(inputProblem, solver.getOutput())
      .endpointComponents,
  ).toEqual(expectedPartition);
});

test("cleanup output cannot mutate the solver's safe snapshot", () => {
  const inputProblem = createProblem();
  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: inputProblem,
    traces: inputProblem.traces ?? [],
  });
  solver.solve();

  const firstOutput = solver.getOutput();
  const firstWire = firstOutput[0]?.route[0];
  if (firstWire?.route_type !== "wire") throw new Error("Expected a wire");
  firstWire.x = 42;

  const secondOutput = solver.getOutput();
  expect(secondOutput).not.toBe(firstOutput);
  expect(secondOutput[0]?.route[0]).toMatchObject({ x: -2 });
});
