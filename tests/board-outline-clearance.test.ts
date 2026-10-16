import { expect, test } from "bun:test";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";

test("trace and via clearance use the physical outline inside larger routing bounds", (): void => {
  const index = new SpatialObstacleIndex({
    layerCount: 2,
    minTraceWidth: 0.15,
    minBoardEdgeClearance: 0.5,
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
    outline: [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }],
    connections: [],
    obstacles: [],
  }, []);
  const traceQuery = {
    start: { x: -4.45, y: -1 },
    end: { x: -4.45, y: 1 },
    width: 0.2,
    layer: "top",
    connectionNames: ["signal"],
  };
  expect(index.collides(traceQuery)).toBe(true);
  expect(index.collides({
    ...traceQuery,
    start: { x: -4.3, y: -1 },
    end: { x: -4.3, y: 1 },
  })).toBe(false);
  const viaQuery = {
    point: { x: -4.3, y: 0 },
    layers: ["top", "bottom"],
    padDiameter: 0.5,
    holeDiameter: 0.25,
    connectionNames: ["signal"],
  };
  expect(index.collidesVia(viaQuery)).toBe(true);
  expect(index.collidesVia({ ...viaQuery, point: { x: -4.2, y: 0 } })).toBe(false);
});
