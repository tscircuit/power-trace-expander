import { expect, test } from "bun:test";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { CollisionQuery, SimpleRouteJson } from "../src/types";

test("prepared queries preserve exact boundary decisions and reject out-of-region use", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.5,
    defaultObstacleMargin: 0.25,
    minBoardEdgeClearance: 0.25,
    bounds: { minX: -4, minY: -4, maxX: 4, maxY: 4 },
    connections: [],
    obstacles: [{
      type: "rect",
      center: { x: 0, y: 0 },
      width: 1,
      height: 1,
      layers: ["top"],
      connectedTo: ["ground"],
    }],
  };
  const index = new SpatialObstacleIndex(input, []);
  for (const layer of ["top", "bottom"]) {
    const query: CollisionQuery = {
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      layer,
      width: 0.5,
      connectionNames: ["power"],
    };
    const check = index.createSegmentCollisionChecker(query, input.bounds);
    for (const edge of [-4, -3.5, -1, 0, 1, 3.5, 4]) {
      for (const offset of [-1e-10, 0, 1e-10]) {
        const value = edge + offset;
        if (value < -4 || value > 4) continue;
        for (const point of [{ x: value, y: 0 }, { x: 0, y: value }]) {
          expect(check(point, point)).toBe(index.collides({
            ...query, start: point, end: point,
          }));
        }
      }
    }
    expect(() => check({ x: -4.01, y: 0 }, query.end)).toThrow(
      "Segment exceeds its prepared collision bounds",
    );
  }
});
