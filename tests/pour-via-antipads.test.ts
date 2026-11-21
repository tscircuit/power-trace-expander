import { expect, test } from "bun:test";
import { SpatialObstacleIndex, type PowerTraceExpanderInput } from "../src";

test("pour antipads permit through vias while foreign wires preserve the plane", (): void => {
  for (const isCopperPour of [true, false]) {
    const input: PowerTraceExpanderInput = {
      layerCount: 4,
      minTraceWidth: 0.1,
      bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
      connections: [],
      obstacles: [
        {
          type: "rect",
          isCopperPour,
          center: { x: 0, y: 0 },
          width: 8,
          height: 8,
          layers: ["inner1"],
          connectedTo: ["ground"],
        },
      ],
    };
    const index = new SpatialObstacleIndex(input, []);
    expect(
      index.collidesVia({
        point: { x: 0, y: 0 },
        layers: index.boardLayers,
        padDiameter: 0.45,
        holeDiameter: 0.2,
        connectionNames: ["power"],
      }),
    ).toBe(!isCopperPour);
    const wire = {
      start: { x: -1, y: 0 },
      end: { x: 1, y: 0 },
      layer: "inner1",
      width: 0.1,
      connectionNames: ["power"],
    };
    expect(index.collides(wire)).toBe(true);
    expect(index.collides({ ...wire, connectionNames: ["ground"] })).toBe(
      false,
    );
    expect(index.collides({ ...wire, layer: "bottom" })).toBe(false);
  }
});
