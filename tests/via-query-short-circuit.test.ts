import { expect, test } from "bun:test";
import { ConnectionNameResolver, SpatialObstacleIndex } from "../src";
import type { SimpleRouteJson, ViaCollisionQuery } from "../src/types";

test("boolean via queries stop at their first collider while signatures capture every layer", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.15,
    bounds: { minX: -3, minY: -3, maxX: 3, maxY: 3 },
    connections: [],
    obstacles: ["top", "bottom"].map((layer) => ({
      type: "rect",
      center: { x: 0, y: 0 },
      width: 1,
      height: 1,
      layers: [layer],
      connectedTo: [],
    })),
  };
  class CountingResolver extends ConnectionNameResolver {
    lookups = 0;
    override canonicalize(names: string[]) {
      this.lookups++;
      return super.canonicalize(names);
    }
  }
  const resolver = new CountingResolver(input);
  const index = new SpatialObstacleIndex(input, [], undefined, [], resolver);
  const query: ViaCollisionQuery = {
    point: { x: 0, y: 0 },
    layers: ["top", "bottom"],
    padDiameter: 0.6,
    holeDiameter: 0.3,
    connectionNames: ["POWER"],
  };
  resolver.lookups = 0;
  expect(index.collidesVia(query)).toBe(true);
  expect(resolver.lookups).toBe(1);

  resolver.lookups = 0;
  expect([...index.getViaViolationSignatures(query)].sort()).toEqual([
    "copper:bottom:obstacle:1",
    "copper:top:obstacle:0",
  ]);
  expect(resolver.lookups).toBe(2);
});
