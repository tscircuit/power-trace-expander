import { expect, test } from "bun:test";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { CollisionQuery, SimpleRouteJson } from "../src/types";

test("opt-in outline checks traces and vias against a concave board edge", (): void => {
  const boardOutline = [
    { x: 0, y: 0 },
    { x: 8, y: 0 },
    { x: 8, y: 8 },
    { x: 5, y: 8 },
    { x: 5, y: 3 },
    { x: 3, y: 3 },
    { x: 3, y: 8 },
    { x: 0, y: 8 },
  ];
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.4,
    minBoardEdgeClearance: 0.3,
    bounds: { minX: 0, minY: 0, maxX: 8, maxY: 8 },
    connections: [],
    obstacles: [],
  };
  const query: CollisionQuery = {
    start: { x: 2, y: 5 },
    end: { x: 6, y: 5 },
    layer: "top",
    width: 0.4,
    connectionNames: ["power"],
  };
  const legacyInput = { ...input, outline: boardOutline };
  const legacy = new SpatialObstacleIndex(legacyInput, []);
  const index = new SpatialObstacleIndex({ ...input, boardOutline }, []);
  const prepared = index.createSegmentCollisionChecker(query, input.bounds);

  // Both endpoints are inside the board but the segment crosses its notch.
  expect(legacy.collides(query)).toBe(false);
  expect(index.collides(query)).toBe(true);
  expect(prepared(query.start, query.end)).toBe(true);

  for (const [x, collides] of [
    [2.5, false],
    [2.55, true],
    [4, true],
  ] as const) {
    const start = { x, y: 4 };
    const end = { x, y: 6 };
    expect(index.collides({ ...query, start, end })).toBe(collides);
    expect(prepared(start, end)).toBe(collides);
    expect(
      index.collidesVia({
        point: start,
        layers: ["top", "bottom"],
        padDiameter: 0.4,
        holeDiameter: 0.2,
        connectionNames: ["power"],
      }),
    ).toBe(collides);
  }
});
