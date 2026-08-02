import { expect, test } from "bun:test";
import {
  PowerTraceExpanderSolver,
  SpatialObstacleIndex,
  type PowerTraceExpanderInput,
} from "../src";

const wire = (x: number, y: number, width = 0.15) => ({
  route_type: "wire" as const,
  x,
  y,
  width,
  layer: "top",
});

test("keeps expanded copper clear of immutable preloaded traces", () => {
  const input = {
    layerCount: 2,
    minTraceWidth: 0.15,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -3, minY: -2, maxX: 3, maxY: 2 },
    obstacles: [],
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 1,
        pointsToConnect: [
          { x: -2, y: 0, layer: "top" },
          { x: 2, y: 0, layer: "top" },
        ],
      },
    ],
    traces: [
      {
        type: "pcb_trace" as const,
        pcb_trace_id: "power",
        connection_name: "POWER",
        route: [wire(-2, 0), wire(2, 0)],
      },
    ],
    fixedTraces: [
      {
        type: "pcb_trace" as const,
        pcb_trace_id: "preloaded-signal",
        connection_name: "SIGNAL",
        route: [wire(-2, 0.35), wire(2, 0.35)],
      },
    ],
  } satisfies PowerTraceExpanderInput;
  const solver = new PowerTraceExpanderSolver(input);

  solver.solve();

  const output = solver.getOutput();
  const wires = output[0]!.route.filter((point) => point.route_type === "wire");
  expect(solver.solved).toBe(true);
  expect(output).toHaveLength(1);
  expect(
    Math.max(
      ...wires
        .filter((point) => point.layer === "top")
        .map((point) => point.width),
    ),
  ).toBeLessThan(1);

  const obstacleIndex = new SpatialObstacleIndex(input, output);
  const route = output[0]!.route;
  for (let index = 0; index < route.length - 1; index++) {
    const start = route[index]!;
    const end = route[index + 1]!;
    if (
      start.route_type !== "wire" ||
      end.route_type !== "wire" ||
      start.layer !== end.layer
    ) {
      continue;
    }
    expect(
      obstacleIndex.collides({
        start,
        end,
        layer: start.layer,
        width: Math.max(start.width, end.width),
        connectionNames: ["POWER"],
        ignoreTraceIndex: 0,
        ignoreRouteRange: { start: index, end: index + 1 },
      }),
    ).toBe(false);
  }
});
