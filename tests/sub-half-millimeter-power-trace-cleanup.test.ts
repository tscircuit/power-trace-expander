import { expect, test } from "bun:test";
import { PowerTraceCleanupSolver, SpatialObstacleIndex } from "../src";
import { countNonOctilinearSegments } from "../src/octilinear";
import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
  WireRoutePoint,
} from "../src/types";

test("straightens a 0.3 mm trace around a neighboring via", () => {
  const traceWidth = 0.3;
  const coordinates = [
    [0, 4.55],
    [1.03, 4.55],
    [1.42, 4.575],
    [1.57, 4.275],
    [1.54, 3.1],
    [1.72, 2.475],
    [1.54, 2.2],
    [1.54, 0.704],
    [0.836, 0],
    [0, 0],
  ] as const;
  const route: WireRoutePoint[] = coordinates.map(([x, y]) => ({
    route_type: "wire",
    x,
    y,
    width: traceWidth,
    layer: "top",
  }));
  const trace: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: "power",
    connection_name: "power",
    route,
  };
  const input: SimpleRouteJson = {
    bounds: { minX: -2, maxX: 4, minY: -1, maxY: 6 },
    layerCount: 2,
    minTraceWidth: 0.15,
    minTraceToPadEdgeClearance: 0.12,
    connections: [
      {
        name: "power",
        nominalTraceWidth: traceWidth,
        pointsToConnect: [
          { x: 0, y: 4.55, layer: "top" },
          { x: 0, y: 0, layer: "top" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        layers: ["top"],
        center: { x: 0, y: 2.275 },
        width: 2.1,
        height: 3.4,
        connectedTo: [],
      },
      {
        type: "oval",
        shape: "circle",
        layers: ["top", "bottom"],
        center: { x: 1.19, y: 2.495 },
        width: 0.4,
        height: 0.4,
        connectedTo: [],
      },
    ],
  };
  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: input,
    traces: [trace],
  });
  solver.solve();

  expect(solver.solved).toBe(true);
  const output = solver.getOutput();
  const points = output[0]!.route.filter(
    (point) => point.route_type === "wire",
  );
  expect(output[0]!.route).toHaveLength(6);
  expect(countNonOctilinearSegments(points)).toBe(0);
  expect(points[0]).toEqual(route[0]);
  expect(points.at(-1)).toEqual(route.at(-1));
  const obstacles = new SpatialObstacleIndex(input, output, 0);
  for (const [index, end] of points.slice(1).entries()) {
    expect(end.width).toBe(traceWidth);
    expect(
      obstacles.collides({
        start: points[index]!,
        end,
        layer: "top",
        width: traceWidth,
        connectionNames: ["power"],
        ignoreTraceIndex: 0,
      }),
    ).toBe(false);
  }
});
