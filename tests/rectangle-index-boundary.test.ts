import { expect, test } from "bun:test";
import { approximateObstacleWithRects } from "../src/geometry";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { CollisionQuery, Obstacle, SimpleRouteJson } from "../src/types";

test("exact rectangles preserve pad, via and hole decisions at rotated clearance boundaries", () => {
  for (const rotation of [0, 37, 90]) {
    for (const kind of ["pad", "via", "hole", "keepout"] as const) {
      const name =
        kind === "pad"
          ? "pcb_smtpad_1"
          : kind === "via"
            ? "pcb_via_1"
            : "ground";
      const obstacle: Obstacle = {
        type: "rect",
        center: { x: 1.23, y: -2.34 },
        width: 8,
        height: 6,
        ccwRotationDegrees: rotation,
        layers: ["top"],
        connectedTo: [name],
        isNonPlatedHole: kind === "hole",
      };
      const srj: SimpleRouteJson = {
        layerCount: 2,
        minTraceWidth: 0.2,
        bounds: { minX: -20, maxX: 20, minY: -20, maxY: 20 },
        connections: [],
        obstacles: [obstacle],
        minTraceToHoleEdgeClearance: 0.35,
        minPadEdgeToPadEdgeClearance: 0.25,
      };
      const exact = new SpatialObstacleIndex(srj, []);
      const tiled = new SpatialObstacleIndex(
        { ...srj, obstacles: [] },
        [],
        undefined,
        approximateObstacleWithRects(obstacle).map((item) => ({
          ...item,
          copperObjectId: "obstacle:0",
        })),
      );
      const radians = (rotation * Math.PI) / 180;
      for (const offset of [0, 0.1, 0.2, 0.3, 0.35, 0.45, 0.5]) {
        for (const epsilon of [-1e-7, 0, 1e-7]) {
          const y = 3 + offset + epsilon;
          const point = {
            x: obstacle.center.x - y * Math.sin(radians),
            y: obstacle.center.y + y * Math.cos(radians),
          };
          for (const layer of ["top", "bottom"]) {
            for (const connectionName of [name, "other"]) {
              for (const blockSameNetObstacles of [false, true]) {
                for (const isVia of [false, true]) {
                  const query: CollisionQuery = {
                    start: point,
                    end: point,
                    layer,
                    width: 0.2,
                    connectionNames: [connectionName],
                    blockSameNetObstacles,
                    isVia,
                    obstacleClearance: 0.2,
                    sameNetObstacleClearance: 0.4,
                  };
                  expect(exact.collides(query)).toBe(tiled.collides(query));
                  expect(exact.getSameNetCopperContactIds(query)).toEqual(
                    tiled.getSameNetCopperContactIds(query),
                  );
                }
              }
            }
          }
        }
      }
    }
  }
});
