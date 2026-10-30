import { expect, test } from "bun:test";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { CollisionQuery, SimpleRouteJson } from "../src/types";

test("prepared per-item bounds preserve narrow-clearance contact tolerances", (): void => {
  for (const holeClearance of [0.1, 0.5]) {
    const input: SimpleRouteJson = {
      layerCount: 2,
      minTraceWidth: 0.2,
      defaultObstacleMargin: 0.1,
      minTraceToHoleEdgeClearance: holeClearance,
      bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
      connections: [],
      obstacles: [
        {
          type: "rect",
          center: { x: 0, y: 0 },
          width: 1,
          height: 1,
          layers: ["top"],
          connectedTo: ["ground"],
        },
        {
          type: "rect",
          center: { x: 5, y: 5 },
          width: 1,
          height: 1,
          layers: ["top"],
          connectedTo: [],
          isNonPlatedHole: true,
        },
      ],
    };
    const index = new SpatialObstacleIndex(input, []);
    const query: CollisionQuery = {
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      layer: "top",
      width: 0.2,
      connectionNames: ["power"],
    };
    const check = index.createSegmentCollisionChecker(query, input.bounds);
    for (const offset of [-2e-9, -1e-10, 0, 1e-10, 5e-10, 2e-9]) {
      for (const point of [
        { x: 0.7 + offset, y: 0 },
        { x: -0.7 - offset, y: 0 },
        { x: 0, y: 0.7 + offset },
      ]) {
        expect(check(point, point)).toBe(
          index.collides({ ...query, start: point, end: point }),
        );
      }
    }
  }
});
