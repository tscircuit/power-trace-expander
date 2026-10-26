import { expect, test } from "bun:test";
import {
  PowerTraceExpanderSolver,
  SpatialObstacleIndex,
  type PowerTraceExpanderInput,
} from "../src";

test("an impossible full-width route retains valid top-only copper without adding vias", () => {
  const input: PowerTraceExpanderInput = {
    bounds: { minX: -10, maxX: 10, minY: -1, maxY: 1 },
    layerCount: 2,
    minTraceWidth: 0.2,
    minTraceToPadEdgeClearance: 0.1,
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 1,
        pointsToConnect: [
          { x: -8, y: 0, layer: "top" },
          { x: 8, y: 0, layer: "top" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        center: { x: -8, y: 0 },
        width: 1.2,
        height: 1.2,
        layers: ["top"],
        connectedTo: ["POWER"],
      },
      {
        type: "rect",
        center: { x: 8, y: 0 },
        width: 1.2,
        height: 1.2,
        layers: ["top"],
        connectedTo: ["POWER"],
      },
      {
        type: "rect",
        center: { x: 0, y: 0.86 },
        width: 2,
        height: 1.2,
        layers: ["top"],
        connectedTo: [],
      },
      {
        type: "rect",
        center: { x: 0, y: -0.86 },
        width: 2,
        height: 1.2,
        layers: ["top"],
        connectedTo: [],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "power",
        connection_name: "POWER",
        route: [
          { route_type: "wire", x: -8, y: 0, width: 0.2, layer: "top" },
          { route_type: "wire", x: 8, y: 0, width: 0.2, layer: "top" },
        ],
      },
    ],
  };
  const solver = new PowerTraceExpanderSolver(input, { allowNewVias: false });
  solver.solve();

  expect(solver.solved).toBe(true);
  const output = solver.getOutput();
  const route = output[0]!.route;
  expect(route[0]).toMatchObject({ x: -8, y: 0, layer: "top" });
  expect(route.at(-1)).toMatchObject({ x: 8, y: 0, layer: "top" });
  const wirePoints = route.filter((point) => point.route_type === "wire");
  const widths = wirePoints.map((point) => point.width);
  expect(Math.min(...widths)).toBeLessThan(1);
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(input.minTraceWidth);
  expect(Math.max(...widths)).toBeLessThanOrEqual(1);
  expect(
    route.every(
      (point) => point.route_type === "wire" && point.layer === "top",
    ),
  ).toBe(true);
  const index = new SpatialObstacleIndex(input, output, 0);
  for (let k = 0; k < route.length - 1; k++) {
    const start = route[k]!,
      end = route[k + 1]!;
    if (start.route_type !== "wire" || end.route_type !== "wire") continue;
    expect(
      index.collides({
        start,
        end,
        layer: start.layer,
        width: Math.max(start.width, end.width),
        connectionNames: ["POWER"],
        ignoreTraceIndex: 0,
        ignoreRouteRange: { start: 0, end: route.length - 1 },
        obstacleClearance: 0.1,
      }),
    ).toBe(false);
  }
});
