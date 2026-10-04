import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { centralObstacleFixture } from "../fixtures/central-obstacle";
import { simplifiedCases } from "../fixtures/simplified-cases";
import {
  PowerTraceExpanderAutorouter,
  PowerTraceExpanderSolver,
  SpatialObstacleIndex,
} from "../src";

const testWire = (x: number, y: number, width = 0.15) => ({
  route_type: "wire" as const,
  x,
  y,
  width,
  layer: "top" as const,
});

test("keeps a trace that already meets its nominal width byte-for-byte", () => {
  const input = structuredClone(centralObstacleFixture);
  input.obstacles = [];
  for (const point of input.traces![0]!.route) {
    if (point.route_type === "wire") point.width = 0.8;
  }
  const originalTraces = structuredClone(input.traces!);
  const solver = new PowerTraceExpanderSolver(input);

  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.budgetLimitedExpansion).toBe(false);
  expect(solver.finalAcceptanceUsed).toBe(false);
  expect(solver.stats.completionReason).toBe("completed");
  expect(solver.stats.resultStatus).toBe("complete");
  expect(solver.keptTraceCount).toBe(1);
  expect(solver.recreatedTraceCount).toBe(0);
  expect(solver.getOutput()).toEqual(originalTraces);
});

test("widens clear intervals and obstacle-reroutes a blocked interval", () => {
  const input = structuredClone(centralObstacleFixture);
  // Keep explicit coverage for the original planar obstacle-aware A*. The
  // dedicated layerChangeWithNecking fixture exercises the multilayer path.
  input.layerCount = 1;
  const solver = new PowerTraceExpanderSolver(input);

  solver.step();
  expect(solver.solved).toBe(false);
  expect(solver.stats.phase).toBe("evaluate-segment");

  solver.solve();

  const wirePoints = solver
    .getOutput()[0]!
    .route.filter((point) => point.route_type === "wire");
  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.expandedSegmentCount).toBeGreaterThan(0);
  expect(solver.reroutedSegmentCount).toBeGreaterThan(0);
  expect(solver.attemptedGridCount).toBeGreaterThan(0);
  expect(solver.attemptedLayerGridCount).toBe(0);
  expect(wirePoints.every((point) => point.width >= 0.8)).toBe(true);
  expect(wirePoints.some((point) => Math.abs(point.y) > 1)).toBe(true);
});

test("inflates a power corridor by locally pushing a lower-width trace", () => {
  const fixture = structuredClone(simplifiedCases.inflationPushesSignal);
  const originalSignal = structuredClone(fixture.traces![1]!.route);
  const solver = new PowerTraceExpanderSolver(fixture);

  solver.solve();

  const [powerTrace, signalTrace] = solver.getOutput();
  const powerWirePoints = powerTrace!.route.filter(
    (point) => point.route_type === "wire",
  );
  expect(solver.solved).toBe(true);
  expect(solver.pushedTraceCount).toBeGreaterThan(0);
  expect(solver.elasticPushedTraceCount).toBeGreaterThan(0);
  expect(signalTrace!.route).not.toEqual(originalSignal);
  const maximumSignalDisplacement = Math.max(
    ...signalTrace!.route
      .filter((point) => point.route_type === "wire")
      .map((point) => Math.abs(point.y - 0.55)),
  );
  expect(maximumSignalDisplacement).toBeGreaterThan(0.05);
  expect(maximumSignalDisplacement).toBeLessThan(0.2);
  expect(
    powerWirePoints.every(
      (point) => point.width >= 0.8 && Math.abs(point.y) < 1e-6,
    ),
  ).toBe(true);
});

test("uses short indexed rectangles for a rotated obstacle", () => {
  const input: SimpleRouteJson = {
    ...structuredClone(centralObstacleFixture),
    traces: [],
    obstacles: [
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 4,
        height: 0.5,
        ccwRotationDegrees: 45,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  };
  const index = new SpatialObstacleIndex(input, []);

  expect(index.items.length).toBeGreaterThan(4);
  expect(
    index.collides({
      start: { x: -2, y: -2 },
      end: { x: 2, y: 2 },
      layer: "top",
      width: 0.2,
      connectionNames: ["OTHER_NET"],
    }),
  ).toBe(true);
  expect(
    index.collides({
      start: { x: -2, y: 2 },
      end: { x: 2, y: 2 },
      layer: "top",
      width: 0.2,
      connectionNames: ["OTHER_NET"],
    }),
  ).toBe(false);
});

test("treats separate same-net traces as connected copper", () => {
  const input = structuredClone(centralObstacleFixture);
  input.obstacles = [];
  input.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "nearby_same_net",
      connection_name: "CHILD_POWER_ALIAS",
      connectsTo: ["shared_power_port"],
      route: [
        {
          route_type: "wire",
          x: -1,
          y: 0.4,
          width: 0.2,
          layer: "top",
        },
        {
          route_type: "wire",
          x: 1,
          y: 0.4,
          width: 0.2,
          layer: "top",
        },
      ],
    },
  ];
  input.connections[0]!.pointsToConnect[0] = {
    ...input.connections[0]!.pointsToConnect[0]!,
    pointId: "shared_power_port",
    pcb_port_id: "shared_power_port",
  };
  const index = new SpatialObstacleIndex(input, input.traces);

  const query = {
    start: { x: -1, y: 0 },
    end: { x: 1, y: 0 },
    layer: "top",
    width: 0.4,
  };

  expect(index.collides({ ...query, connectionNames: ["MOTOR_VBUS"] })).toBe(
    false,
  );
  expect(index.collides({ ...query, connectionNames: ["OTHER"] })).toBe(true);
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

test("keeps port-aliased child routing while treating it as same-net copper", () => {
  const input = structuredClone(simplifiedCases.straightClear);
  input.connections[0]!.pointsToConnect[0] = {
    ...input.connections[0]!.pointsToConnect[0]!,
    pointId: "shared_child_port",
    pcb_port_id: "shared_child_port",
  };
  const childTrace = {
    type: "pcb_trace" as const,
    pcb_trace_id: "child-power-alias",
    connection_name: "CHILD_POWER_ALIAS",
    connectsTo: ["shared_child_port", "child_internal_port"],
    route: [
      {
        route_type: "wire" as const,
        x: -1,
        y: 1,
        width: 0.15,
        layer: "top" as const,
      },
      {
        route_type: "wire" as const,
        x: -0.5,
        y: 1.4,
        width: 0.15,
        layer: "top" as const,
      },
      {
        route_type: "wire" as const,
        x: 0,
        y: 1,
        width: 0.15,
        layer: "top" as const,
      },
      {
        route_type: "wire" as const,
        x: 0.5,
        y: 1.4,
        width: 0.15,
        layer: "top" as const,
      },
      {
        route_type: "wire" as const,
        x: 1,
        y: 1,
        width: 0.15,
        layer: "top" as const,
      },
    ],
  };
  input.traces!.push(childTrace);
  const originalChildRoute = structuredClone(childTrace.route);
  const solver = new PowerTraceExpanderSolver(input);

  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.getOutput()[1]!.route).toEqual(originalChildRoute);
  expect(
    (solver.stats as { cleanupMutatedTraceIndices: number[] })
      .cleanupMutatedTraceIndices,
  ).not.toContain(1);
  expect(solver.stats).toMatchObject({ immutableTraceMutationIds: [] });
});

test("final acceptance rolls back an opaque child mutation", () => {
  const input = structuredClone(simplifiedCases.straightClear);
  input.traces!.push({
    type: "pcb_trace",
    pcb_trace_id: "opaque-child",
    connection_name: "CHILD",
    connectsTo: ["child-left", "child-right"],
    route: [testWire(-1, 2), testWire(0, 2.5), testWire(1, 2)],
  });
  const solver = new PowerTraceExpanderSolver(input);
  const original = structuredClone(solver.getOutput());
  const candidate = structuredClone(solver.traces);
  candidate[1]!.route = [testWire(-1, 2), testWire(1, 2)];
  const internalSolver = solver as unknown as {
    acceptConnectivityCheckpoint: (
      traces: typeof candidate,
      phase: "final",
    ) => boolean;
  };

  expect(internalSolver.acceptConnectivityCheckpoint(candidate, "final")).toBe(
    false,
  );
  expect(solver.getOutput()).toEqual(original);
  expect(solver.immutableTraceMutationIds).toEqual(["opaque-child"]);
  expect(solver.connectivityRollbackCount).toBe(0);
  expect(solver.immutableSafetyRollbackCount).toBe(1);
  expect(solver.immutableSafetyRollbackPhases).toEqual(["final"]);
  solver.tryFinalAcceptance();
  expect(solver.stats).toMatchObject({
    completionReason: "immutable_safety_rollback",
    connectivityRollbackCount: 0,
    immutableSafetyRollbackCount: 1,
    resultStatus: "best_effort",
  });
});

test("final acceptance rejects a new collision with an immutable via", () => {
  const input = structuredClone(simplifiedCases.straightClear);
  input.connections[0]!.pointsToConnect = [
    { x: -2, y: 2, layer: "top" },
    { x: 2, y: 2, layer: "top" },
  ];
  input.traces![0]!.route = [testWire(-2, 2), testWire(2, 2)];
  input.obstacles.push({
    type: "rect",
    obstacleId: "existing-child-pad-violation",
    center: { x: 0, y: 0 },
    width: 0.4,
    height: 0.4,
    layers: ["top"],
    connectedTo: ["CHILD"],
  });
  input.traces!.push({
    type: "pcb_trace",
    pcb_trace_id: "opaque-via",
    connection_name: "CHILD",
    route: [
      testWire(0, 0),
      {
        route_type: "via",
        x: 0,
        y: 0,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: 0.6,
        via_hole_diameter: 0.3,
      },
      { ...testWire(0, 0), layer: "bottom" },
      { ...testWire(1, 0), layer: "bottom" },
    ],
  });
  const solver = new PowerTraceExpanderSolver(input);
  const original = structuredClone(solver.getOutput());
  const candidate = structuredClone(solver.traces);
  candidate[0]!.route = [
    testWire(-2, 2),
    testWire(-1, 0),
    testWire(1, 0),
    testWire(2, 2),
  ];
  const internalSolver = solver as unknown as {
    acceptConnectivityCheckpoint: (
      traces: typeof candidate,
      phase: "final",
    ) => boolean;
  };

  expect(solver.initialImmutableViaViolationCount).toBe(1);
  expect(solver.initialImmutableViaViolationPairCount).toBe(1);
  expect(internalSolver.acceptConnectivityCheckpoint(candidate, "final")).toBe(
    false,
  );
  expect(solver.getOutput()).toEqual(original);
  expect(solver.immutableViaViolationRollbackCount).toBe(1);
  expect(
    solver.immutableViaViolationRegressionIds.some((signature) =>
      signature.includes("|copper:top:trace:0"),
    ),
  ).toBe(true);
  expect(solver.connectivityRollbackCount).toBe(0);
  expect(solver.immutableSafetyRollbackCount).toBe(1);
  expect(solver.immutableSafetyRollbackPhases).toEqual(["final"]);
});

test("keeps an unowned child blocker immutable during local inflation", () => {
  const input = structuredClone(simplifiedCases.inflationPushesSignal);
  input.connections = input.connections.filter(
    (connection) => connection.name !== "SIGNAL",
  );
  const childTrace = input.traces?.[1];
  if (!childTrace) throw new Error("Expected a blocking child trace");
  childTrace.connection_name = "CHILD_SIGNAL";
  const originalChildRoute = structuredClone(childTrace.route);

  const solver = new PowerTraceExpanderSolver(input);
  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.getOutput()[1]?.route).toEqual(originalChildRoute);
  expect(solver.pushedTraceCount).toBe(0);
});

test("validates widened route-point transitions conservatively", () => {
  const input = structuredClone(simplifiedCases.straightClear);
  input.obstacles = [
    {
      type: "rect",
      center: { x: -1.5, y: 0.45 },
      width: 0.5,
      height: 0.2,
      layers: ["top"],
      connectedTo: [],
    },
  ];
  input.traces![0]!.route = [
    {
      route_type: "wire",
      x: -2,
      y: 0,
      width: 0.15,
      layer: "top",
    },
    {
      route_type: "wire",
      x: 0,
      y: 0,
      width: 0.15,
      layer: "top",
    },
    {
      route_type: "wire",
      x: 2,
      y: 0,
      width: 0.15,
      layer: "top",
    },
    {
      route_type: "wire",
      x: 4,
      y: 0,
      width: 0.15,
      layer: "top",
    },
  ];
  const solver = new PowerTraceExpanderSolver(input);
  const internalSolver = solver as unknown as {
    traceIndex: number;
    rebuildObstacleIndex: () => void;
    canExpandSegmentAndEndpoints: (
      trace: (typeof solver.traces)[number],
      segmentIndex: number,
      connectionNames: string[],
      targetWidth: number,
    ) => boolean;
  };
  internalSolver.traceIndex = 0;
  internalSolver.rebuildObstacleIndex();

  // The serialized segment starts at point 0, but core's board DRC validates
  // the copper transition around point 1 against this adjacent obstacle.
  expect(
    internalSolver.canExpandSegmentAndEndpoints(
      solver.traces[0]!,
      1,
      ["POWER"],
      0.8,
    ),
  ).toBe(false);
});

test("allows same-net vias but keeps different-net vias as obstacles", () => {
  const input = structuredClone(centralObstacleFixture);
  input.obstacles = [];
  input.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "trace_with_via",
      connection_name: "POWER",
      route: [
        {
          route_type: "via",
          x: 0,
          y: 0,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.6,
        },
      ],
    },
  ];
  const index = new SpatialObstacleIndex(input, input.traces);

  const query = {
    start: { x: -1, y: 0 },
    end: { x: 0, y: 0 },
    layer: "top",
    width: 0.4,
    ignoreTraceIndex: 0,
    ignoreRouteRange: { start: 0, end: 1 },
  };

  expect(index.collides({ ...query, connectionNames: ["POWER"] })).toBe(false);
  expect(index.collides({ ...query, connectionNames: ["OTHER"] })).toBe(true);
});

test("keeps same-net via drills mechanically separated", () => {
  const input = structuredClone(centralObstacleFixture);
  input.obstacles = [];
  input.minViaHoleEdgeToViaHoleEdgeClearance = 0.1;
  input.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "trace_with_via",
      connection_name: "POWER",
      route: [
        {
          route_type: "via",
          x: 0,
          y: 0,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.6,
          via_hole_diameter: 0.2,
        },
      ],
    },
  ];
  const index = new SpatialObstacleIndex(input, input.traces);
  const collidesAt = (x: number) =>
    index.collidesVia({
      point: { x, y: 0 },
      layers: ["top", "bottom"],
      padDiameter: 0.3,
      holeDiameter: 0.2,
      connectionNames: ["POWER"],
    });

  expect(collidesAt(0.29)).toBe(true);
  expect(collidesAt(0.31)).toBe(false);

  const dynamicIndex = new SpatialObstacleIndex(input, input.traces, 0);
  expect(
    dynamicIndex.collidesVia({
      point: { x: 0.29, y: 0 },
      layers: ["top", "bottom"],
      padDiameter: 0.3,
      holeDiameter: 0.2,
      connectionNames: ["POWER"],
    }),
  ).toBe(true);
});

test("checks same-index vias from distinct fixed traces independently", () => {
  const input = structuredClone(centralObstacleFixture);
  input.obstacles = [];
  input.traces = [];
  input.minViaHoleEdgeToViaHoleEdgeClearance = 0.2;
  input.fixedTraces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "fixed-via-outside-drill-radius",
      connection_name: "POWER",
      route: [
        testWire(-1, -1),
        {
          route_type: "via",
          x: 0.35,
          y: 0.35,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.01,
          via_hole_diameter: 0.2,
        },
      ],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "fixed-via-inside-drill-radius",
      connection_name: "POWER",
      route: [
        testWire(1, 1),
        {
          route_type: "via",
          x: 0.2,
          y: 0,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.01,
          via_hole_diameter: 0.2,
        },
      ],
    },
  ];
  const index = new SpatialObstacleIndex(input, []);
  const query = {
    point: { x: 0, y: 0 },
    layers: ["top", "bottom"],
    padDiameter: 0.01,
    holeDiameter: 0.2,
    connectionNames: ["POWER"],
  };

  expect(index.collidesVia(query)).toBe(true);
  expect(
    [...index.getViaViolationSignatures(query)].some((signature) =>
      signature.includes("fixed-trace:1"),
    ),
  ).toBe(true);
});

test("uses shared port aliases for same-net pads", () => {
  const input = structuredClone(centralObstacleFixture);
  input.traces = [];
  input.connections[0]!.pointsToConnect[0] = {
    ...input.connections[0]!.pointsToConnect[0]!,
    pointId: "shared_pad_port",
    pcb_port_id: "shared_pad_port",
  };
  input.obstacles = [
    {
      type: "rect",
      center: { x: 0, y: 0 },
      width: 1,
      height: 1,
      layers: ["top"],
      connectedTo: ["PAD_ALIAS", "shared_pad_port"],
    },
  ];
  const index = new SpatialObstacleIndex(input, []);
  const query = {
    start: { x: -1, y: 0 },
    end: { x: 1, y: 0 },
    layer: "top",
    width: 0.4,
  };

  expect(index.collides({ ...query, connectionNames: ["MOTOR_VBUS"] })).toBe(
    false,
  );
  expect(index.collides({ ...query, connectionNames: ["OTHER"] })).toBe(true);
});

test("uses separate pair and board-edge clearances", () => {
  const input = structuredClone(centralObstacleFixture);
  input.defaultObstacleMargin = 0.1;
  input.minTraceToPadEdgeClearance = 0.1;
  input.minBoardEdgeClearance = 0.2;
  input.traces = [];
  input.obstacles = [
    {
      type: "rect",
      center: { x: 0, y: 0 },
      width: 0.2,
      height: 0.2,
      layers: ["top"],
      connectedTo: [],
    },
  ];
  const index = new SpatialObstacleIndex(input, []);

  expect(
    index.collides({
      start: { x: -0.5, y: 0.31 },
      end: { x: 0.5, y: 0.31 },
      layer: "top",
      width: 0.2,
      connectionNames: ["POWER"],
    }),
  ).toBe(false);
  expect(
    index.collides({
      start: { x: -0.5, y: 0.29 },
      end: { x: 0.5, y: 0.29 },
      layer: "top",
      width: 0.2,
      connectionNames: ["POWER"],
    }),
  ).toBe(true);
  expect(
    index.collides({
      start: { x: 4.71, y: 2 },
      end: { x: 4.71, y: 2 },
      layer: "top",
      width: 0.2,
      connectionNames: ["POWER"],
    }),
  ).toBe(true);
});

test("uses exact capsule checks after the Flatbush broad phase", () => {
  const input = structuredClone(centralObstacleFixture);
  input.defaultObstacleMargin = 0.1;
  input.minTraceToPadEdgeClearance = 0.1;
  input.obstacles = [];
  input.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "diagonal-obstacle",
      connection_name: "OTHER",
      route: [
        {
          route_type: "wire",
          x: -1,
          y: -1,
          width: 0.2,
          layer: "top",
        },
        {
          route_type: "wire",
          x: 1,
          y: 1,
          width: 0.2,
          layer: "top",
        },
      ],
    },
  ];
  const index = new SpatialObstacleIndex(input, input.traces);
  const queryAt = (y: number) =>
    index.collides({
      start: { x: 0, y },
      end: { x: 0, y },
      layer: "top",
      width: 0.2,
      connectionNames: ["POWER"],
    });

  expect(queryAt(0.5)).toBe(false);
  expect(queryAt(0.35)).toBe(true);
});

test("targeted mode uses aliases, forwards through the autorouter, and measures its own plateau", () => {
  const input = structuredClone(simplifiedCases.straightClear);
  input.bounds = { minX: -6, maxX: 6, minY: -5, maxY: 5 };
  input.connections = [
    {
      name: "POWER",
      source_trace_id: "POWER_SOURCE_ALIAS",
      nominalTraceWidth: 0.8,
      pointsToConnect: [
        { x: -0.005, y: 0, layer: "top" },
        { x: 0.005, y: 0, layer: "top" },
      ],
    },
    {
      name: "BACKGROUND",
      nominalTraceWidth: 0.8,
      pointsToConnect: [
        { x: -5, y: 4, layer: "top" },
        { x: 5, y: 4, layer: "top" },
      ],
    },
  ];
  input.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "selected-power",
      connection_name: "POWER",
      route: [testWire(-0.005, 0), testWire(0.005, 0)],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "large-background",
      connection_name: "BACKGROUND",
      route: [testWire(-5, 4), testWire(5, 4)],
    },
  ];
  const originalBackground = structuredClone(input.traces[1]);
  const options = { onlyConnectionNames: ["POWER_SOURCE_ALIAS"] };
  const solver = new PowerTraceExpanderSolver(input, options);

  solver.solve();

  expect(solver.stats.selectedTraceCount).toBe(1);
  expect(solver.completedPassCount).toBe(2);
  expect(
    solver
      .getOutput()[0]!
      .route.filter((point) => point.route_type === "wire")
      .every((point) => point.width === 0.8),
  ).toBe(true);
  expect(solver.getOutput()[1]).toEqual(originalBackground);

  const autorouter = new PowerTraceExpanderAutorouter(
    structuredClone(input),
    options,
  );
  const autorouterOutput = autorouter.solveSync();
  expect(autorouter.solver.stats.selectedTraceCount).toBe(1);
  expect(autorouterOutput[1]).toEqual(originalBackground);
});

test("targeted mode can move and final-repair an owned nearby blocker", () => {
  const input = structuredClone(simplifiedCases.inflationPushesSignal);
  const originalSignalRoute = structuredClone(input.traces?.[1]?.route);
  const solver = new PowerTraceExpanderSolver(input, {
    onlyConnectionNames: ["POWER"],
  });

  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.pushedTraceCount).toBeGreaterThan(0);
  expect(solver.getOutput()[1]?.route).not.toEqual(originalSignalRoute);
  expect(solver.stats.expansionPushedTraceIndices).toContain(1);
  expect(solver.unresolvedSegmentCount).toBe(0);
});

test("autorouter adapter emits a tscircuit-compatible complete event", () => {
  const autorouter = new PowerTraceExpanderAutorouter(
    structuredClone(centralObstacleFixture),
  );
  let completedTraceCount = 0;
  let error: Error | undefined;
  autorouter.on("complete", ({ traces }) => {
    completedTraceCount = traces.length;
  });
  autorouter.on("error", (event) => {
    error = event.error;
  });

  autorouter.start();

  expect(error).toBeUndefined();
  expect(completedTraceCount).toBe(1);
});
