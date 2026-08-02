import { expect, test } from "bun:test";
import {
  PowerTraceExpanderSolver,
  SpatialObstacleIndex,
  type PowerTraceExpanderInput,
} from "../src";

const wire = (x: number, width: number, y = 0) => ({
  route_type: "wire" as const,
  x,
  y,
  width,
  layer: "top",
});

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
  const initialIndex = new SpatialObstacleIndex(input, input.traces);
  expect(
    initialIndex.getConnectedPadEndpointWidthLimitAtPoint(
      {
        start: input.traces[0]!.route[0]!,
        end: input.traces[0]!.route[1]!,
        layer: "top",
        width: 0.5,
        connectionNames: ["POWER"],
        ignoreTraceIndex: 0,
        ignoreRouteRange: { start: 0, end: 1 },
      },
      input.traces[0]!.route[0]!,
    ),
  ).toBeCloseTo(0.3, 6);

  const solver = new PowerTraceExpanderSolver(input);
  solver.solve();

  const wires = solver
    .getOutput()[0]!
    .route.filter((point) => point.route_type === "wire");
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
