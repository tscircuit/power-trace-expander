import { expect, test } from "bun:test";
import { ConnectionNameResolver } from "../src/ConnectionNameResolver";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { PowerTraceExpanderInput } from "../src/types";

test("caches board aliases without retaining transient trace alias arrays", (): void => {
  const aliases = ["pad", "POWER"];
  const input: PowerTraceExpanderInput = {
    bounds: { minX: -5, minY: -5, maxX: 5, maxY: 5 },
    layerCount: 1,
    minTraceWidth: 0.2,
    connections: [],
    obstacles: [
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: aliases,
      },
    ],
  };
  const resolver = new ConnectionNameResolver(input);
  const cached = resolver.canonicalizeToSet(aliases);
  const transient = [...aliases];
  const first = resolver.canonicalizeToSet(transient);
  expect([...first]).toEqual([...cached]);
  expect(resolver.canonicalizeToSet(transient)).not.toBe(first);
  expect(resolver.canonicalizeToSet(aliases)).toBe(cached);

  // Cleanup/inflation index cloned boards while sharing a net resolver.
  const clone = structuredClone(input);
  const originalIndex = new SpatialObstacleIndex(
    input,
    [],
    undefined,
    [],
    resolver,
  );
  expect(resolver.canonicalizeToSet(aliases)).toBe(cached);
  new SpatialObstacleIndex(input, [], undefined, [], resolver);
  expect(resolver.canonicalizeToSet(aliases)).toBe(cached);
  new SpatialObstacleIndex(clone, [], undefined, [], resolver);
  const clonedAliases = clone.obstacles[0]!.connectedTo;
  const clonedSet = resolver.canonicalizeToSet(clonedAliases);
  expect([...clonedSet]).toEqual([...cached]);
  new SpatialObstacleIndex(clone, [], undefined, [], resolver);
  expect(resolver.canonicalizeToSet(clonedAliases)).toBe(clonedSet);
  expect(resolver.canonicalizeToSet(aliases)).not.toBe(cached);
  expect(
    originalIndex.collides({
      start: { x: -1, y: 0 },
      end: { x: 1, y: 0 },
      layer: "top",
      width: 0.2,
      connectionNames: ["POWER"],
      ignoreTraceIndex: -1,
    }),
  ).toBe(false);
  new SpatialObstacleIndex(input, [], undefined, [], resolver);
  expect(resolver.canonicalizeToSet(clonedAliases)).not.toBe(clonedSet);

  // Replacing an obstacle's array remains correct without growing the cache.
  input.obstacles[0]!.connectedTo = ["another-net"];
  const replacement = resolver.canonicalizeToSet(
    input.obstacles[0]!.connectedTo,
  );
  expect([...replacement]).toEqual(["another-net"]);
  expect(resolver.canonicalizeToSet(input.obstacles[0]!.connectedTo)).not.toBe(
    replacement,
  );
});
