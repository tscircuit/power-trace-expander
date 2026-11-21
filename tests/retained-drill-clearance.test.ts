import { expect, test } from "bun:test";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";

test("power expansion reserves an original drill independently of net ownership", (): void => {
  const index = new SpatialObstacleIndex(
    {
      layerCount: 2,
      minTraceWidth: 0.1,
      minViaHoleEdgeToViaHoleEdgeClearance: 0.4,
      bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
      connections: [],
      obstacles: [
        {
          type: "rect",
          shape: "circle",
          center: { x: 0, y: 0 },
          width: 0.6,
          height: 0.6,
          holeDiameter: 0.3,
          layers: ["top", "bottom"],
          connectedTo: ["GND"],
        },
      ],
    },
    [],
  );
  const query = {
    point: { x: 0.6, y: 0 },
    layers: ["top", "bottom"],
    padDiameter: 0.45,
    holeDiameter: 0.2,
    connectionNames: ["GND"],
  };
  expect(index.collidesVia(query)).toBeTrue();
  expect(
    index.collidesVia({ ...query, point: { x: 0.65001, y: 0 } }),
  ).toBeFalse();
  expect(
    index.collides({
      start: query.point,
      end: { x: 0, y: 0 },
      layer: "top",
      width: 0.1,
      connectionNames: ["GND"],
    }),
  ).toBeFalse();
});
