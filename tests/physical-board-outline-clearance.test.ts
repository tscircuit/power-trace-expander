import { expect, test } from "bun:test";
import "bun-match-svg";
import { getSvgFromGraphicsObject } from "graphics-debug";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { CollisionQuery } from "../src/types";

test("a trace and a via are accepted in a concave board cutout", async () => {
  const input = {
    layerCount: 2,
    minTraceWidth: 0.4,
    minBoardEdgeClearance: 0.3,
    bounds: { minX: 0, minY: 0, maxX: 8, maxY: 8 },
    outline: [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 8 },
      { x: 5, y: 8 },
      { x: 5, y: 3 },
      { x: 3, y: 3 },
      { x: 3, y: 8 },
      { x: 0, y: 8 },
    ],
    connections: [],
    obstacles: [],
  };
  const index = new SpatialObstacleIndex(input, []);
  const query: CollisionQuery = {
    start: { x: 2, y: 5 },
    end: { x: 6, y: 5 },
    layer: "top",
    width: 0.4,
    connectionNames: ["power"],
  };
  const via = {
    point: { x: 4, y: 7.15 },
    layers: ["top", "bottom"],
    padDiameter: 0.4,
    holeDiameter: 0.2,
    connectionNames: ["power"],
  };

  // Both endpoints are on the PCB, but the segment between them crosses air.
  const traceBlocked = index.collides(query);
  const viaBlocked = index.collidesVia(via);
  const prepared = index.createSegmentCollisionChecker(query, input.bounds);
  expect(traceBlocked).toBe(false);
  expect(prepared(query.start, query.end)).toBe(false);
  expect(viaBlocked).toBe(false);

  const color = (blocked: boolean) => (blocked ? "#b91c1c" : "#087f5b");
  const svg = getSvgFromGraphicsObject(
    {
      coordinateSystem: "cartesian",
      polygons: [{
        points: input.outline, fill: "rgba(71,85,105,0.09)",
        stroke: "#475569", strokeWidth: 0.04,
      }],
      lines: [{
        points: [query.start, query.end],
        strokeWidth: query.width, strokeColor: color(traceBlocked),
      }],
      circles: [
        { center: via.point, radius: via.padDiameter / 2, fill: color(viaBlocked) },
        { center: via.point, radius: via.holeDiameter / 2, fill: "white" },
      ],
    },
    { backgroundColor: "white", svgWidth: 440, svgHeight: 400 },
  );
  await expect(svg).toMatchSvgSnapshot(import.meta.path);
});
