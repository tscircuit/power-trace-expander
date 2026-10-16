import { expect, test } from "bun:test";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";

test("a trace cannot cross a board notch when both endpoints are inside the board", (): void => {
  const index = new SpatialObstacleIndex({
    layerCount: 2,
    minTraceWidth: 0.15,
    minBoardEdgeClearance: 0.1,
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
    outline: [
      { x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 },
      { x: 2, y: 5 }, { x: 2, y: -2 }, { x: -2, y: -2 },
      { x: -2, y: 5 }, { x: -5, y: 5 },
    ],
    connections: [],
    obstacles: [],
  }, []);
  const query = {
    start: { x: -3, y: 0 },
    end: { x: 3, y: 0 },
    width: 0.15,
    layer: "top",
    connectionNames: ["signal"],
  };
  expect(index.collides(query)).toBe(true);
  expect(index.collides({ ...query, end: { x: -3, y: 2 } })).toBe(false);
});
