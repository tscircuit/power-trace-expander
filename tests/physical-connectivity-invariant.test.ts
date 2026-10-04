import { expect, test } from "bun:test";
import { splitUnderWidthWireSegments } from "../src/geometry";
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

test("rejects a component swap even when connected endpoint counts are equal", () => {
  const input = baseProblem([
    { x: -2, y: 1, layer: "top", pointId: "A" },
    { x: -2, y: -1, layer: "top", pointId: "B" },
    { x: 2, y: 1, layer: "top", pointId: "C" },
    { x: 2, y: -1, layer: "top", pointId: "D" },
  ]);
  const baselineTraces = [
    trace("left", [wire(-2, 1), wire(-2, -1)]),
    trace("right", [wire(2, 1), wire(2, -1)]),
  ];
  const swappedTraces = [
    trace("top", [wire(-2, 1), wire(2, 1)]),
    trace("bottom", [wire(-2, -1), wire(2, -1)]),
  ];

  const invariant = new PhysicalConnectivityInvariant(input, baselineTraces);
  const validation = invariant.validate(swappedTraces);

  expect(invariant.baseline.endpointComponents).toEqual([
    ["0:0", "0:1"],
    ["0:2", "0:3"],
  ]);
  expect(validation.candidate.endpointComponents).toEqual([
    ["0:0", "0:2"],
    ["0:1", "0:3"],
  ]);
  expect(validation.safe).toBe(false);
  expect(validation.regressions).toHaveLength(2);
});

test("uses first-route-point width and splitting preserves asymmetric copper", () => {
  const wideToNarrow = [wire(0, 0, 1), wire(2, 0, 0.2)];
  expect(splitUnderWidthWireSegments(wideToNarrow, 1)).toEqual(wideToNarrow);

  const narrowToWide = [wire(0, 0, 0.2), wire(2, 0, 1)];
  const split = splitUnderWidthWireSegments(
    narrowToWide,
    1,
  ) as WireRoutePoint[];
  expect(split.map((point) => point.width)).toEqual([0.2, 0.2, 1]);

  const input = baseProblem([
    { x: 0, y: 0, layer: "top", pointId: "left" },
    { x: 2, y: 0, layer: "top", pointId: "right" },
    { x: 1, y: 0.09, layer: "top", pointId: "edge-contact" },
  ]);
  const before = capturePhysicalConnectivity(input, [
    trace("asymmetric", narrowToWide),
  ]);
  const after = capturePhysicalConnectivity(input, [
    trace("asymmetric", split),
  ]);
  expect(before.endpointComponents).toEqual([["0:0", "0:1", "0:2"]]);
  expect(after.endpointComponents).toEqual(before.endpointComponents);
});

test("same-net obstacles can bridge terminal components", () => {
  const input = baseProblem([
    { x: -0.5, y: 0, layer: "top", pointId: "left" },
    { x: 0.5, y: 0, layer: "top", pointId: "right" },
  ]);
  input.obstacles = [
    {
      type: "rect",
      center: { x: -0.5, y: 0 },
      width: 1,
      height: 1,
      layers: ["top"],
      connectedTo: ["NET", "left"],
    },
    {
      type: "rect",
      center: { x: 0.5, y: 0 },
      width: 1,
      height: 1,
      layers: ["top"],
      connectedTo: ["NET", "right"],
    },
  ];

  expect(capturePhysicalConnectivity(input, []).endpointComponents).toEqual([
    ["0:0", "0:1"],
  ]);
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

test("netConnectionName resolves into the connection's single canonical net", () => {
  const input = baseProblem([
    { x: -1, y: 0, layer: "top", pointId: "left" },
    { x: 1, y: 0, layer: "top", pointId: "right" },
  ]);
  input.connections[0]!.netConnectionName = "canonical-net";
  const traces = [trace("net-alias", [wire(-1, 0), wire(1, 0)])];

  const invariant = new PhysicalConnectivityInvariant(input, traces);
  const validation = invariant.validate(traces);

  expect(invariant.baseline.endpointComponents).toEqual([["0:0", "0:1"]]);
  expect(validation.candidate.endpointComponents).toEqual([["0:0", "0:1"]]);
  expect(validation.safe).toBe(true);
});

test("the full expander owns and widens a netConnectionName trace", () => {
  const input = baseProblem([
    { x: -1, y: 0, layer: "top", pointId: "left" },
    { x: 1, y: 0, layer: "top", pointId: "right" },
  ]);
  input.nominalTraceWidth = 0.8;
  input.connections[0]!.name = "logical-connection";
  input.connections[0]!.netConnectionName = "canonical-net";
  input.connections[0]!.nominalTraceWidth = 0.8;
  input.traces = [
    trace("net-alias", [wire(-1, 0, 0.2), wire(1, 0, 0.2)], "canonical-net"),
  ];

  const solver = new PowerTraceExpanderSolver(input);
  solver.solve();
  const output = solver.getOutput();
  const outputWireWidths = output[0]?.route
    .filter((point) => point.route_type === "wire")
    .map((point) => point.width);

  expect(outputWireWidths?.length).toBeGreaterThan(1);
  expect(outputWireWidths?.every((width) => width === 0.8)).toBe(true);
  expect(solver.stats).toMatchObject({
    resultStatus: "complete",
    nominalTraceWidth: 0.8,
  });
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

test("models circular oval pads instead of their rectangular bounds", () => {
  const input = baseProblem([
    { x: -1, y: 3, layer: "top", pointId: "A" },
    { x: 3, y: -1, layer: "top", pointId: "B" },
    { x: 0, y: 0, layer: "top", pointId: "branch" },
  ]);
  input.obstacles = [
    {
      type: "oval",
      obstacleId: "round-branch-pad",
      center: { x: 0, y: 0 },
      width: 2,
      height: 2,
      layers: ["top"],
      connectedTo: ["NET", "branch"],
    },
  ];
  const baseline = [
    trace("bent", [wire(-1, 3, 0.8), wire(0.6, 0.6, 0.8), wire(3, -1, 0.8)]),
  ];
  const rectangularCornerOnly = [
    trace("shortcut", [wire(-1, 3, 0.8), wire(3, -1, 0.8)]),
  ];

  const invariant = new PhysicalConnectivityInvariant(input, baseline);
  const validation = invariant.validate(rectangularCornerOnly);

  expect(invariant.baseline.endpointComponents).toEqual([
    ["0:0", "0:1", "0:2"],
  ]);
  expect(validation.safe).toBe(false);
  expect(validation.candidate.endpointComponents).toContainEqual([
    "0:0",
    "0:1",
  ]);
  expect(validation.candidate.componentByEndpointKey["0:2"]).not.toBe(
    validation.candidate.componentByEndpointKey["0:0"],
  );
});

test("suppresses a jumper placeholder wire while bridging only its pads", () => {
  const input = baseProblem([
    { x: -0.825, y: 0, layer: "top", pointId: "jumper-left" },
    { x: 0.825, y: 0, layer: "top", pointId: "jumper-right" },
    { x: 0, y: -1, layer: "top", pointId: "under-bottom" },
    { x: 0, y: 1, layer: "top", pointId: "under-top" },
  ]);
  const jumperTrace = trace("jumper", [
    wire(-0.825, 0),
    wire(0.825, 0),
    {
      route_type: "jumper",
      start: { x: -0.825, y: 0 },
      end: { x: 0.825, y: 0 },
      footprint: "0603",
      layer: "top",
    },
  ]);
  const underBodyTrace = trace("under-body", [wire(0, -1), wire(0, 1)]);
  const invariant = new PhysicalConnectivityInvariant(input, [
    jumperTrace,
    underBodyTrace,
  ]);

  expect(invariant.baseline.endpointComponents).toEqual([
    ["0:0", "0:1"],
    ["0:2", "0:3"],
  ]);
  expect(invariant.validate([underBodyTrace]).safe).toBe(false);
});

test("accepts the legacy capacity-router 0603 jumper spacing", () => {
  const input = baseProblem([
    { x: -0.9, y: 0, layer: "top", pointId: "jumper-left" },
    { x: 0.9, y: 0, layer: "top", pointId: "jumper-right" },
  ]);
  const legacyJumperTrace = trace("legacy-jumper", [
    wire(-0.9, 0),
    wire(0.9, 0),
    {
      route_type: "jumper",
      start: { x: -0.9, y: 0 },
      end: { x: 0.9, y: 0 },
      footprint: "0603",
      layer: "top",
    },
  ]);

  const invariant = new PhysicalConnectivityInvariant(input, [
    legacyJumperTrace,
  ]);
  expect(invariant.baseline.endpointComponents).toEqual([["0:0", "0:1"]]);
  expect(invariant.validate([legacyJumperTrace]).safe).toBe(true);
});

test("through-obstacle markers require a same-net multilayer witness", () => {
  const input: PowerTraceExpanderInput = {
    ...baseProblem([
      { x: -0.5, y: 0, layer: "top", pointId: "through-top" },
      { x: 0.5, y: 0, layer: "bottom", pointId: "through-bottom" },
    ]),
    layerCount: 2,
  };
  input.obstacles = [
    {
      type: "rect",
      obstacleId: "plated-pad",
      center: { x: 0, y: 0 },
      width: 2,
      height: 2,
      layers: ["top", "bottom"],
      connectedTo: ["NET"],
    },
  ];
  const throughTrace = trace("through-obstacle", [
    {
      route_type: "through_obstacle",
      start: { x: -0.5, y: 0 },
      end: { x: 0.5, y: 0 },
      from_layer: "top",
      to_layer: "bottom",
      width: 0.2,
    },
  ]);
  const invariant = new PhysicalConnectivityInvariant(input, [throughTrace]);

  expect(invariant.baseline.endpointComponents).toEqual([["0:0", "0:1"]]);
  expect(invariant.validate([throughTrace]).safe).toBe(true);

  const malformedTrace = structuredClone(throughTrace);
  const marker = malformedTrace.route[0];
  if (marker?.route_type !== "through_obstacle") {
    throw new Error("Expected through-obstacle marker");
  }
  marker.end = { x: 3, y: 0 };
  const validation = invariant.validate([malformedTrace]);
  expect(validation.safe).toBe(false);
  expect(validation.validationError).toContain(
    "no same-net multilayer obstacle witness",
  );
});

test("a non-colocated wire-via adjacency fails closed", () => {
  const input: PowerTraceExpanderInput = {
    ...baseProblem([
      { x: -1, y: 0, layer: "top", pointId: "top-terminal" },
      { x: 1, y: 0, layer: "bottom", pointId: "bottom-terminal" },
    ]),
    layerCount: 2,
  };
  const ambiguousTrace = trace("ambiguous-via", [
    wire(-1, 0, 0.2, "top"),
    {
      route_type: "via",
      x: 0,
      y: 0,
      from_layer: "top",
      to_layer: "bottom",
    },
    wire(1, 0, 0.2, "bottom"),
  ]);
  const invariant = new PhysicalConnectivityInvariant(input, [ambiguousTrace]);

  expect(invariant.validate([ambiguousTrace])).toMatchObject({
    safe: true,
    validationError: expect.stringContaining(
      "adjacent to a non-colocated wire endpoint",
    ),
  });
  expect(invariant.validate([])).toMatchObject({
    safe: false,
    validationError: expect.stringContaining("failed closed"),
  });
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
