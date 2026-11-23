import { expect, test } from "bun:test";
import "bun-match-svg";
import {
  type GraphicsObject,
  getSvgFromGraphicsObject,
  stackGraphicsHorizontally,
} from "graphics-debug";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { CollisionQuery, SimpleRouteJson } from "../src/types";

test("opt-in outline checks traces and vias against a concave board edge", async () => {
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
  const panels = [legacy, index].map((checker): GraphicsObject => {
    const prepared = checker.createSegmentCollisionChecker(query, input.bounds);
    const color = (blocked: boolean) => (blocked ? "#b91c1c" : "#087f5b");
    // Both endpoints are on the board. The span between them crosses the notch.
    const crossesNotch = checker.collides(query);
    expect(crossesNotch).toBe(checker === index);
    expect(prepared(query.start, query.end)).toBe(crossesNotch);
    const lines = [
      {
        points: [query.start, query.end],
        strokeWidth: query.width,
        strokeColor: color(crossesNotch),
      },
    ];
    const circles: NonNullable<GraphicsObject["circles"]> = [];
    for (const [x, y, blockedByOutline] of [
      [2.5, 3.4, false], // Exactly 0.3 mm between copper and the notch.
      [2.55, 6.1, true],
      [4, 6.1, true],
    ] as const) {
      const start = { x, y };
      const end = { x, y: y + 0.65 };
      const blocked = checker.collides({ ...query, start, end });
      expect(blocked).toBe(checker === index && blockedByOutline);
      expect(prepared(start, end)).toBe(blocked);
      lines.push({
        points: [start, end],
        strokeWidth: query.width,
        strokeColor: color(blocked),
      });

      const via = {
        point: { x, y: y + 1.05 },
        layers: ["top", "bottom"],
        padDiameter: 0.4,
        holeDiameter: 0.2,
        connectionNames: ["power"],
      };
      const viaBlocked = checker.collidesVia(via);
      expect(viaBlocked).toBe(checker === index && blockedByOutline);
      circles.push(
        {
          center: via.point,
          radius: via.padDiameter / 2,
          fill: color(viaBlocked),
        },
        { center: via.point, radius: via.holeDiameter / 2, fill: "white" },
      );
    }
    return {
      coordinateSystem: "cartesian",
      polygons: [{
        points: boardOutline,
        fill: "rgba(71,85,105,0.09)",
        stroke: "#475569",
        strokeWidth: 0.04,
      }],
      lines,
      circles,
    };
  });
  const comparison = stackGraphicsHorizontally(panels, {
    titles: ["Rectangular bounds", "Physical board outline"],
  });
  await expect(
    getSvgFromGraphicsObject(comparison, {
      backgroundColor: "white",
      svgWidth: 940,
      svgHeight: 460,
    }),
  ).toMatchSvgSnapshot(import.meta.path);
});
