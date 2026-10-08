import { expect, test } from "bun:test";
import {
  createFragmentedConnectedPadNeckdownProblem,
  FRAGMENTED_PAD_CONNECTION,
  FRAGMENTED_PAD_ID,
} from "../fixtures/fragmented-connected-pad-neckdown/createFragmentedConnectedPadNeckdownProblem";
import {
  type PowerTraceExpanderInput,
  PowerTraceExpanderSolver,
  SpatialObstacleIndex,
} from "../src";

const wire = (x: number, width: number, y = 0) => ({
  route_type: "wire" as const,
  x,
  y,
  width,
  layer: "top",
});

const getFirstTraceEndpoints = (input: PowerTraceExpanderInput) => {
  const trace = input.traces?.[0];
  const start = trace?.route[0];
  const end = trace?.route[1];
  if (!trace || start?.route_type !== "wire" || end?.route_type !== "wire") {
    throw new Error("Expected the fixture to contain a routed wire trace");
  }
  return { trace, start, end };
};

test("does not widen a power escape beyond its connected pad", () => {
  const input = {
    layerCount: 2,
    minTraceWidth: 0.5,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -1, minY: -2, maxX: 4, maxY: 2 },
    obstacles: [
      {
        type: "rect" as const,
        center: { x: 0, y: 0 },
        width: 1.1,
        height: 0.3,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_left", "POWER"],
      },
      {
        type: "rect" as const,
        center: { x: 3, y: 0 },
        width: 0.54,
        height: 0.64,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_right", "POWER"],
      },
    ],
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 0.5,
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 3, y: 0, layer: "top" },
        ],
      },
    ],
    traces: [
      {
        type: "pcb_trace" as const,
        pcb_trace_id: "power",
        connection_name: "POWER",
        route: [
          wire(0, 0.3),
          wire(0.00003, 0.3, -0.000187),
          wire(1.1, 0.3),
          wire(2.46, 0.5),
          wire(3, 0.5),
        ],
      },
    ],
  } satisfies PowerTraceExpanderInput;
  const { start, end } = getFirstTraceEndpoints(input);
  const initialIndex = new SpatialObstacleIndex(input, input.traces);
  expect(
    initialIndex.getConnectedPadEndpointWidthLimitAtPoint(
      {
        start,
        end,
        layer: "top",
        width: 0.5,
        connectionNames: ["POWER"],
        ignoreTraceIndex: 0,
        ignoreRouteRange: { start: 0, end: 1 },
      },
      start,
    ),
  ).toBeCloseTo(0.3, 6);

  const solver = new PowerTraceExpanderSolver(input);
  solver.solve();

  const outputTrace = solver.getOutput()[0];
  if (!outputTrace) throw new Error("Expected the solver to return a trace");
  const wires = outputTrace.route.filter(
    (point) => point.route_type === "wire",
  );
  expect(solver.solved).toBe(true);
  expect(
    wires
      .filter((point) => point.x <= 0.55 + 1e-9)
      .every((point) => point.width <= 0.3 + 1e-9),
  ).toBe(true);
  expect(
    wires.some(
      (point) => point.x > 0.55 && point.x < 2.7 && point.width >= 0.5,
    ),
  ).toBe(true);
});

test("measures adjacent fragments with one pad id as one copper region", () => {
  const input = createFragmentedConnectedPadNeckdownProblem();
  const trace = input.traces?.[0];
  const connection = input.connections[0];
  const terminal = connection?.pointsToConnect[0];
  const destination = connection?.pointsToConnect[1];
  if (!trace || !terminal || !destination) {
    throw new Error("Expected the fixture to contain one complete connection");
  }
  const query = {
    start: terminal,
    end: destination,
    layer: terminal.layer,
    width: 0.5,
    connectionNames: [FRAGMENTED_PAD_CONNECTION],
    ignoreTraceIndex: 0,
    ignoreRouteRange: { start: 0, end: 1 },
  };
  const obstacleIndex = new SpatialObstacleIndex(input, [trace]);

  expect(
    obstacleIndex.getConnectedPadWidthLimitAtPoint(query, terminal),
  ).toBeCloseTo(0.28, 6);
  expect(
    obstacleIndex.getConnectedPadEndpointWidthLimitAtPoint(query, terminal),
  ).toBeCloseTo(0.28, 6);
  expect(obstacleIndex.getConnectedPadBoundaryPoint(query, "start")).toEqual({
    x: 0.3,
    y: 0.01,
  });
});

test("keeps separate pads distinct when their aliases share one net", () => {
  const sharedConnectedTo = ["pcb_smtpad_lower", "pcb_smtpad_upper", "POWER"];
  const input = {
    layerCount: 2,
    minTraceWidth: 0.15,
    bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
    connections: [],
    obstacles: [
      {
        type: "rect" as const,
        center: { x: 0, y: -0.05 },
        width: 0.6,
        height: 0.1,
        layers: ["top"],
        connectedTo: sharedConnectedTo,
        circuitJsonMetadata: { pcb_smtpad_id: "pcb_smtpad_lower" },
      },
      {
        type: "rect" as const,
        center: { x: 0, y: 0.05 },
        width: 0.6,
        height: 0.1,
        layers: ["top"],
        connectedTo: sharedConnectedTo,
        circuitJsonMetadata: { pcb_smtpad_id: "pcb_smtpad_upper" },
      },
    ],
  } satisfies PowerTraceExpanderInput;
  const query = {
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
    layer: "top",
    width: 0.15,
    connectionNames: ["POWER"],
  };
  const obstacleIndex = new SpatialObstacleIndex(input, []);

  expect(
    obstacleIndex.getConnectedPadEndpointWidthLimitAtPoint(query, query.start),
  ).toBeCloseTo(0, 9);
});

test("keeps a neckdown when the complete fragmented pad is narrow", () => {
  const input = createFragmentedConnectedPadNeckdownProblem();
  const padFragments = input.obstacles.filter((obstacle) =>
    obstacle.connectedTo.includes(FRAGMENTED_PAD_ID),
  );
  for (const [fragmentIndex, obstacle] of padFragments.entries()) {
    obstacle.center.y = (fragmentIndex - 1) * 0.04;
    obstacle.height = 0.04;
  }
  const query = {
    start: { x: 0, y: 0 },
    end: { x: 3, y: 0 },
    layer: "top",
    width: 0.5,
    connectionNames: [FRAGMENTED_PAD_CONNECTION],
  };
  const obstacleIndex = new SpatialObstacleIndex(input, input.traces ?? []);

  expect(
    obstacleIndex.getConnectedPadWidthLimitAtPoint(query, query.start),
  ).toBeCloseTo(0.12, 6);
  expect(
    obstacleIndex.getConnectedPadEndpointWidthLimitAtPoint(query, query.start),
  ).toBeCloseTo(0.12, 6);
});

test("finds the outer boundary across adjacent pad fragments", () => {
  const input = createFragmentedConnectedPadNeckdownProblem();
  const padFragments = input.obstacles.filter((obstacle) =>
    obstacle.connectedTo.includes(FRAGMENTED_PAD_ID),
  );
  for (const [fragmentIndex, obstacle] of padFragments.entries()) {
    obstacle.center.x = (fragmentIndex - 1) * 0.2;
    obstacle.center.y = 0;
    obstacle.width = 0.2;
    obstacle.height = 0.3;
  }
  const query = {
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
    layer: "top",
    width: 0.5,
    connectionNames: [FRAGMENTED_PAD_CONNECTION],
  };
  const obstacleIndex = new SpatialObstacleIndex(input, input.traces ?? []);

  const boundary = obstacleIndex.getConnectedPadBoundaryPoint(query, "start");
  expect(boundary?.x).toBeCloseTo(0.3, 9);
  expect(boundary?.y).toBeCloseTo(0, 9);
});

test("uses the exposed union boundary for a concave fragmented pad", () => {
  const input = {
    layerCount: 2,
    minTraceWidth: 0.15,
    bounds: { minX: -2, minY: -2, maxX: 2, maxY: 2 },
    connections: [],
    obstacles: [
      {
        type: "rect" as const,
        center: { x: 0, y: -0.5 },
        width: 2,
        height: 1,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_concave", "POWER"],
      },
      {
        type: "rect" as const,
        center: { x: -0.5, y: 0.5 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_concave", "POWER"],
      },
    ],
  } satisfies PowerTraceExpanderInput;
  const query = {
    start: { x: -0.1, y: -0.1 },
    end: { x: 1, y: -0.1 },
    layer: "top",
    width: 0.5,
    connectionNames: ["POWER"],
  };
  const obstacleIndex = new SpatialObstacleIndex(input, []);

  expect(
    obstacleIndex.getConnectedPadEndpointWidthLimitAtPoint(query, query.start),
  ).toBeCloseTo(2 * Math.hypot(0.1, 0.1), 9);
});
