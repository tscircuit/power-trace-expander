import { expect, test } from "bun:test";
import {
  capturePhysicalConnectivity,
  PhysicalConnectivityInvariant,
} from "../src/PhysicalConnectivityInvariant";
import { PowerTraceExpanderSolver } from "../src/PowerTraceExpanderSolver";
import type {
  PowerTraceExpanderInput,
  SimplifiedPcbTrace,
  WireRoutePoint,
} from "../src/types";

const wire = (
  x: number,
  y: number,
  width = 0.1,
  layer = "top",
): WireRoutePoint => ({ route_type: "wire", x, y, width, layer });

const trace = (
  id: string,
  route: SimplifiedPcbTrace["route"],
  connectionName = "NET",
): SimplifiedPcbTrace => ({
  type: "pcb_trace",
  pcb_trace_id: id,
  connection_name: connectionName,
  route,
});

const baseProblem = (
  pointsToConnect: PowerTraceExpanderInput["connections"][number]["pointsToConnect"],
): PowerTraceExpanderInput => ({
  layerCount: 1,
  minTraceWidth: 0.1,
  bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
  connections: [{ name: "NET", pointsToConnect }],
  obstacles: [],
  traces: [],
});

test("includes aliases, fixed traces, and the physical via layer span", () => {
  const input: PowerTraceExpanderInput = {
    ...baseProblem([
      { x: -1, y: 0, layer: "top", pointId: "top-terminal" },
      { x: 1, y: 0, layer: "bottom", pointId: "bottom-terminal" },
      { x: 0.45, y: 0, layer: "inner1", pointId: "via-edge-terminal" },
    ]),
    layerCount: 4,
    minViaPadDiameter: 1,
    fixedTraces: [
      {
        ...trace(
          "fixed-child-route",
          [
            wire(-1, 0, 0.2, "top"),
            wire(0, 0, 0.2, "top"),
            {
              route_type: "via",
              x: 0,
              y: 0,
              from_layer: "top",
              to_layer: "bottom",
            },
            wire(0, 0, 0.2, "bottom"),
            wire(1, 0, 0.2, "bottom"),
          ],
          "CHILD_ALIAS",
        ),
        rootConnectionName: "NET",
      },
    ],
  };

  expect(capturePhysicalConnectivity(input, []).endpointComponents).toEqual([
    ["0:0", "0:1", "0:2"],
  ]);
});

test("uses the upstream position-layer alias when explicit net IDs differ", () => {
  const input = baseProblem([
    { x: 0, y: 0, layer: "top", pointId: "A" },
    { x: 2, y: 0, layer: "top", pointId: "B" },
  ]);
  input.connections[0]!.name = "CONNECTION";
  input.obstacles = [
    {
      type: "rect",
      obstacleId: "pad-at-a",
      center: { x: 0, y: 0 },
      width: 0.5,
      height: 0.5,
      layers: ["top"],
      connectedTo: ["PAD_NET"],
    },
  ];
  const baseline = [
    trace("pad-net-trace", [wire(0, 0), wire(2, 0)], "PAD_NET"),
  ];

  const invariant = new PhysicalConnectivityInvariant(input, baseline);
  expect(invariant.baseline.endpointComponents).toEqual([["0:0", "0:1"]]);
  expect(invariant.validate([]).safe).toBe(false);
});

test("legal non-circular ellipses fail closed without crashing", () => {
  const input = baseProblem([
    { x: -1, y: 0, layer: "top", pointId: "left" },
    { x: 1, y: 0, layer: "top", pointId: "right" },
  ]);
  input.obstacles = [
    {
      type: "oval",
      obstacleId: "ellipse",
      center: { x: 0, y: 0 },
      width: 2,
      height: 1,
      layers: ["top"],
      connectedTo: ["NET"],
    },
  ];
  input.nominalTraceWidth = 0.8;
  input.connections[0]!.nominalTraceWidth = 0.8;
  const baseline = [trace("ellipse-trace", [wire(-1, 0), wire(1, 0)])];
  input.traces = structuredClone(baseline);

  const invariant = new PhysicalConnectivityInvariant(input, baseline);
  expect(invariant.validate(structuredClone(baseline)).safe).toBe(true);

  const validation = invariant.validate([
    trace("ellipse-trace", [wire(-1, 1), wire(1, 1)]),
  ]);
  expect(validation.safe).toBe(false);
  expect(validation.validationError).toContain(
    "does not yet support non-circular oval obstacle ellipse",
  );

  const solver = new PowerTraceExpanderSolver(input);
  solver.solve();
  expect(solver.solved).toBe(true);
  expect(solver.getOutput()).toEqual(baseline);
  expect(solver.stats).toMatchObject({
    resultStatus: "best_effort",
    completionReason: "connectivity_rollback",
    connectivityRollbackPhases: ["expansion"],
    recreatedTraceCount: 0,
    expandedSegmentCount: 0,
    connectivityRollbackMutationStats: {
      recreatedTraceCount: 1,
      expandedSegmentCount: 3,
    },
    discardedExpansionMutationStats: null,
  });
});

test("an unchanged unsupported baseline is surfaced as best effort", () => {
  const input = baseProblem([
    { x: -1, y: 0, layer: "top", pointId: "left" },
    { x: 1, y: 0, layer: "top", pointId: "right" },
  ]);
  input.obstacles = [
    {
      type: "oval",
      obstacleId: "ellipse",
      center: { x: 0, y: 0 },
      width: 2,
      height: 1,
      layers: ["top"],
      connectedTo: ["NET"],
    },
  ];
  const baseline = [trace("ellipse-trace", [wire(-1, 0), wire(1, 0)])];
  input.traces = structuredClone(baseline);

  const solver = new PowerTraceExpanderSolver(input);
  solver.solve();

  expect(solver.getOutput()).toEqual(baseline);
  expect(solver.stats).toMatchObject({
    resultStatus: "best_effort",
    completionReason: "connectivity_validation_unavailable",
    connectivityRollbackCount: 0,
  });
  expect(solver.stats.connectivityValidationError).toContain(
    "does not yet support non-circular oval obstacle ellipse",
  );
});

test("completed solver output cannot mutate the validated checkpoint", () => {
  const input = baseProblem([
    { x: -1, y: 0, layer: "top", pointId: "left" },
    { x: 1, y: 0, layer: "top", pointId: "right" },
  ]);
  input.traces = [trace("safe", [wire(-1, 0), wire(1, 0)])];
  const solver = new PowerTraceExpanderSolver(input);
  solver.solve();

  const firstOutput = solver.getOutput();
  const firstWire = firstOutput[0]?.route[0];
  if (firstWire?.route_type !== "wire") throw new Error("Expected a wire");
  firstWire.x = 42;

  const secondOutput = solver.getOutput();
  expect(secondOutput).not.toBe(firstOutput);
  expect(secondOutput[0]?.route[0]).toMatchObject({ x: -1 });
});

test("normalizes through-via copper independently of the routing transition", () => {
  const input = baseProblem([
    { x: -1, y: 0, layer: "top" },
    { x: 1, y: 0, layer: "inner1" },
    { x: 0.45, y: 0, layer: "bottom" },
  ]);
  input.layerCount = 4;
  const route: SimplifiedPcbTrace[] = [
    trace("via", [
      wire(-1, 0),
      wire(0, 0),
      {
        route_type: "via",
        x: 0,
        y: 0,
        from_layer: "top",
        to_layer: "inner1",
        via_diameter: 1,
      },
      wire(0, 0, 0.1, "inner1"),
      wire(1, 0, 0.1, "inner1"),
    ]),
  ];
  expect(capturePhysicalConnectivity(input, route).endpointComponents).toEqual([
    ["0:0", "0:1", "0:2"],
  ]);
  const via = route[0]!.route[2]!;
  if (via.route_type !== "via") throw new Error("Expected via");
  via.layers = ["top", "inner1"];
  expect(capturePhysicalConnectivity(input, route).endpointComponents).toEqual([
    ["0:0", "0:1"],
    ["0:2"],
  ]);
});
