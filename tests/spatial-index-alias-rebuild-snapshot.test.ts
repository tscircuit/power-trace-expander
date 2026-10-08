import { expect, test } from "bun:test";
import "bun-match-svg";
import { ConnectionNameResolver, SpatialObstacleIndex } from "../src";
import type { CollisionQuery, SimpleRouteJson } from "../src/types";
import {
  aliasIndexSnapshot,
  drawAliasIndex,
} from "./helpers/alias-index-snapshot";

test("rebuilding after a same-length alias edit blocks copper that changed nets", async (): Promise<void> => {
  const aliases = ["pcb_smtpad_power", "POWER"];
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.2,
    bounds: { minX: -5, maxX: 5, minY: -3, maxY: 3 },
    connections: [
      { name: "POWER", source_trace_id: "power-source", pointsToConnect: [] },
      { name: "SIGNAL", source_trace_id: "signal-source", pointsToConnect: [] },
    ],
    obstacles: [
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 6,
        height: 2.4,
        layers: ["top"],
        connectedTo: aliases,
      },
    ],
  };
  const resolver = new ConnectionNameResolver(input);
  const before = new SpatialObstacleIndex(input, [], undefined, [], resolver);
  const query: CollisionQuery = {
    start: { x: -4, y: 0 },
    end: { x: 4, y: 0 },
    layer: "top",
    width: 0.3,
    connectionNames: ["power-source"],
  };
  expect(before.collides(query)).toBe(false);
  const beforePanel = drawAliasIndex({
    input,
    queries: [{ query, blocked: false }],
    notes: [
      "POWER query: allowed through its own pad",
      "One alias list shared by 40 collision cells",
    ],
  });

  // Array identity and length stay unchanged. A global identity-only cache
  // would silently allow POWER to cross a pad that now belongs to SIGNAL.
  aliases.splice(0, aliases.length, "pcb_smtpad_signal", "SIGNAL");
  const after = new SpatialObstacleIndex(input, [], undefined, [], resolver);
  expect(after.items[0]!.connectionNames).toBe(aliases);
  expect(after.items).toHaveLength(40);
  expect(after.collides(query)).toBe(true);
  expect(after.collides({ ...query, connectionNames: ["signal-source"] })).toBe(
    false,
  );
  expect(after.collides({ ...query, layer: "bottom" })).toBe(false);
  expect(
    after.collides({
      ...query,
      connectionNames: ["signal-source"],
      blockSameNetObstacles: true,
    }),
  ).toBe(true);
  expect(before.collides(query)).toBe(false);

  // Reusing the resolver must agree with rebuilding all connectivity afresh.
  const fresh = new SpatialObstacleIndex(input, []);
  for (const connectionNames of [
    ["power-source"],
    ["signal-source"],
    ["UNRELATED"],
  ]) {
    for (const layer of ["top", "bottom"]) {
      expect(after.collides({ ...query, connectionNames, layer })).toBe(
        fresh.collides({ ...query, connectionNames, layer }),
      );
    }
  }
  const svg = aliasIndexSnapshot(
    [
      beforePanel,
      drawAliasIndex({
        input,
        obstacleColors: ["rgba(234,88,12,0.20)"],
        queries: [{ query, blocked: true }],
        notes: [
          "POWER query: blocked by the SIGNAL pad",
          "Same array, same length; aliases refreshed",
        ],
      }),
    ],
    [
      "Initial index: pad belongs to POWER",
      "Rebuilt index: pad belongs to SIGNAL",
    ],
  );
  await expect(svg).toMatchSvgSnapshot(import.meta.path);

  // Length changes invalidate the cache too, while a different resolver owns
  // an independent interpretation of the same alias array.
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
  const otherResolver = new ConnectionNameResolver({
    ...input,
    obstacles: [{ ...input.obstacles[0]!, connectedTo: [...aliases, "POWER"] }],
  });
  expect(
    new SpatialObstacleIndex(input, [], undefined, [], otherResolver).collides(
      query,
    ),
  ).toBe(false);
  expect(after.collides(query)).toBe(true);
});
