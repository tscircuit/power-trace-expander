import { expect, test } from "bun:test";
import { ConnectionNameResolver } from "../src/ConnectionNameResolver";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { CollisionQuery, SimpleRouteJson } from "../src/types";

class CountingConnectionNameResolver extends ConnectionNameResolver {
  canonicalizedAliasCount = 0;

  override canonicalize(names: string[]): string[] {
    this.canonicalizedAliasCount += names.length;
    return super.canonicalize(names);
  }
}

test("subdividing a copper pour does not repeat its full alias resolution", (): void => {
  const aliases = Array.from({ length: 512 }, (_, index) => `ground-${index}`);
  const problem: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -20, maxX: 20, minY: -20, maxY: 20 },
    connections: [],
    obstacles: [
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 20,
        height: 20,
        ccwRotationDegrees: 30,
        layers: ["top"],
        connectedTo: aliases,
        isCopperPour: true,
      },
    ],
  };
  const resolver = new CountingConnectionNameResolver(problem);
  const obstacleIndex = new SpatialObstacleIndex(
    problem,
    [],
    undefined,
    [],
    resolver,
  );
  expect(obstacleIndex.items.length).toBeGreaterThan(1000);
  expect(resolver.canonicalizedAliasCount).toBeLessThanOrEqual(
    aliases.length * 2,
  );
  const query: CollisionQuery = {
    start: { x: -1, y: 0 },
    end: { x: 1, y: 0 },
    width: 0.1,
    layer: "top",
    connectionNames: ["signal"],
  };
  expect(obstacleIndex.collides(query)).toBe(true);
  expect(
    obstacleIndex.collides({ ...query, connectionNames: ["ground-511"] }),
  ).toBe(false);
  expect(obstacleIndex.collides({ ...query, layer: "bottom" })).toBe(false);

  // Rebuilding after an alias changes must use the new electrical network.
  aliases.push("signal");
  const rebuiltIndex = new SpatialObstacleIndex(problem, []);
  expect(rebuiltIndex.collides(query)).toBe(false);
});
