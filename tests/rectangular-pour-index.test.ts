import { expect, test } from "bun:test";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { CollisionQuery, SimpleRouteJson } from "../src/types";

test("index rectangular pours once while preserving tiled clearance and contact decisions", () => {
  for (const rotation of [0, 37, 90]) {
    const srj: SimpleRouteJson = {
      layerCount: 2, minTraceWidth: 0.2,
      bounds: { minX: -20, maxX: 20, minY: -20, maxY: 20 },
      connections: [],
      obstacles: [{
        type: "rect", isCopperPour: true,
        center: { x: 0, y: 0 }, width: 8, height: 6,
        ccwRotationDegrees: rotation,
        layers: ["top"], connectedTo: ["ground"],
      }],
    };
    const compact = new SpatialObstacleIndex(srj, []);
    const tiled = new SpatialObstacleIndex({
      ...srj,
      obstacles: srj.obstacles.map((obstacle) => ({ ...obstacle, isCopperPour: false })),
    }, []);
    expect(compact.items.length).toBe(1);
    expect(tiled.items.length).toBeGreaterThan(100);
    for (const layer of ["top", "bottom"]) {
      for (const connectionName of ["ground", "power"]) {
        for (const blockSameNetObstacles of [true, false]) {
          for (let step = 0; step <= 120; step++) {
            const y = -6 + step * 0.1;
            const query: CollisionQuery = {
              start: { x: -9, y }, end: { x: 9, y: y + 0.3 },
              width: 0.2, layer, connectionNames: [connectionName],
              blockSameNetObstacles,
            };
            expect(compact.collides(query)).toBe(tiled.collides(query));
            expect(compact.getSameNetCopperContactIds(query)).toEqual(
              tiled.getSameNetCopperContactIds(query),
            );
          }
        }
      }
    }
  }
  // This is the board-sized geometry from bugreport110. Only two entries
  // are needed instead of 110,538 cells; both layer restrictions remain.
  const large: SimpleRouteJson = {
    layerCount: 4, minTraceWidth: 0.15,
    bounds: { minX: -80, maxX: 80, minY: -62, maxY: 62 },
    connections: [],
    obstacles: ["inner1", "inner2"].map((layer) => ({
      type: "rect", isCopperPour: true, center: { x: 0, y: 0 },
      width: 160, height: 124, layers: [layer], connectedTo: [layer],
    })),
  };
  expect(new SpatialObstacleIndex(large, []).items.length).toBe(2);
});
