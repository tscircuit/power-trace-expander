import { expect, test } from "bun:test";
import { ConnectionNameResolver } from "../src/ConnectionNameResolver";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { PowerTraceExpanderInput } from "../src/types";

test("reuses resolved copper aliases across index rebuilds and invalidates changed aliases", () => {
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
  const first = resolver.canonicalizeToSet(aliases);
  const query = {
    start: { x: -1, y: 0 },
    end: { x: 1, y: 0 },
    layer: "top",
    width: 0.2,
    connectionNames: ["POWER"],
    ignoreTraceIndex: -1,
  };
  for (let index = 0; index < 3; index++) {
    const spatial = new SpatialObstacleIndex(
      input,
      [],
      undefined,
      [],
      resolver,
    );
    expect(spatial.collides(query)).toBe(false);
    expect(resolver.canonicalizeToSet(aliases)).toBe(first);
  }

  // Same-length replacement must invalidate too, not just push/pop changes.
  aliases.splice(0, 2, "other-pad", "OTHER");
  const changed = resolver.canonicalizeToSet(aliases);
  expect(changed).not.toBe(first);
  expect([...changed]).toEqual(resolver.canonicalize(aliases));
  expect(
    new SpatialObstacleIndex(input, [], undefined, [], resolver).collides(
      query,
    ),
  ).toBe(true);
  aliases.push("POWER");
  expect(
    new SpatialObstacleIndex(input, [], undefined, [], resolver).collides(
      query,
    ),
  ).toBe(false);
  aliases.pop();
  expect(
    new SpatialObstacleIndex(input, [], undefined, [], resolver).collides(
      query,
    ),
  ).toBe(true);

  // The same alias array can mean another net in another resolver.
  const otherInput = {
    ...input,
    obstacles: [{ ...input.obstacles[0]!, connectedTo: [...aliases, "POWER"] }],
  };
  const otherResolver = new ConnectionNameResolver(otherInput);
  expect(
    new SpatialObstacleIndex(input, [], undefined, [], otherResolver).collides(
      query,
    ),
  ).toBe(false);
});
