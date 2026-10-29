import { expect, test } from "bun:test";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type {
  CollisionQuery,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "../src/types";

test("layer-scoped collision searches match the global index across nets, holes and through vias", () => {
  const srj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.2,
    bounds: { minX: -50, minY: -50, maxX: 50, maxY: 50 },
    connections: [],
    obstacles: Array.from({ length: 40 }, (_, index) => ({
      type: "rect",
      center: { x: (index % 10) - 5, y: Math.floor(index / 10) - 2 },
      width: 0.7,
      height: 0.4,
      ccwRotationDegrees: index * 13,
      layers: [["top"], ["inner1"], ["inner2"], ["bottom"], ["top", "bottom"]][
        index % 5
      ]!,
      connectedTo: [index % 2 ? "power" : "ground"],
      isNonPlatedHole: index % 7 === 0,
    })),
  };
  const traces: SimplifiedPcbTrace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "via-trace",
      connection_name: "power",
      route: [
        { route_type: "wire", x: -2, y: 0, width: 0.3, layer: "top" },
        { route_type: "wire", x: 0, y: 0, width: 0.3, layer: "top" },
        {
          route_type: "via",
          x: 0,
          y: 0,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.6,
        },
        { route_type: "wire", x: 0, y: 0, width: 0.3, layer: "bottom" },
        { route_type: "wire", x: 2, y: 0, width: 0.3, layer: "bottom" },
      ],
    },
  ];
  const index = new SpatialObstacleIndex(srj, traces);
  for (const layer of ["top", "inner1", "inner2", "bottom", "empty-layer"]) {
    for (let step = 0; step < 140; step++) {
      for (const connectionName of ["power", "foreign"]) {
        for (const blockSameNetObstacles of [false, true]) {
          const query: CollisionQuery = {
            start: { x: -7 + step * 0.1, y: -2.5 },
            end: { x: -6.8 + step * 0.1, y: 2.5 },
            width: 0.2,
            layer,
            connectionNames: [connectionName],
            blockSameNetObstacles,
            obstacleClearance: 0.25,
            sameNetObstacleClearance: 0.4,
            ignoreTraceIndex: step % 2 ? 0 : undefined,
            ignoreRouteRange: step % 2 ? { start: 0, end: 1 } : undefined,
          };
          const originalOrder = index.findCollisions(query);
          expect(index.collides(query)).toBe(originalOrder.length > 0);
          expect(index.findCollisions(query)).toEqual(originalOrder);
        }
      }
    }
  }
  for (const layer of ["top", "inner1", "inner2", "bottom"]) {
    expect(
      index.collides({
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
        layer,
        width: 0.1,
        connectionNames: ["foreign"],
      }),
    ).toBe(true);
  }
  expect(
    index.collides({
      start: { x: 60, y: 0 },
      end: { x: 61, y: 0 },
      layer: "empty-layer",
      width: 0.1,
      connectionNames: [],
    }),
  ).toBe(true);
});
