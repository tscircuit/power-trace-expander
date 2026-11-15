import { expect, test } from "bun:test";
import "bun-match-svg";
import { SpatialObstacleIndex } from "../src/SpatialObstacleIndex";
import type { CollisionQuery, SimpleRouteJson } from "../src/types";
import {
  aliasIndexSnapshot,
  CountingAliasResolver,
  drawAliasIndex,
} from "./helpers/alias-index-snapshot";

test("dense power copper resolves aliases per object rather than per collision rectangle", async (): Promise<void> => {
  // Reduced model of the bugreport107 bottleneck: a large copper region and
  // a long routed trace have many rectangles, but just two alias arrays.
  // Repeating net resolution for every rectangle multiplies work on rebuilds.
  const aliases = [
    "POWER",
    "pcb_smtpad_power",
    ...Array.from({ length: 126 }, (_, index) => `power-port-${index}`),
  ];
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.15,
    bounds: { minX: -12, maxX: 12, minY: -7, maxY: 7 },
    connections: [{ name: "POWER", pointsToConnect: [] }],
    obstacles: [
      {
        type: "rect",
        isCopperPour: true,
        center: { x: 0, y: 3 },
        width: 8,
        height: 5,
        layers: ["top"],
        connectedTo: aliases,
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "long-power-trace",
        connection_name: "POWER",
        mergedConnectionNames: aliases.slice(1),
        route: [
          { route_type: "wire", x: -10, y: -3, layer: "top", width: 0.15 },
          { route_type: "wire", x: 0, y: -3, layer: "top", width: 0.15 },
          { route_type: "wire", x: 10, y: -3, layer: "top", width: 0.15 },
          {
            route_type: "via",
            x: 10,
            y: -3,
            from_layer: "top",
            to_layer: "bottom",
          },
        ],
      },
    ],
  };
  const resolver = new CountingAliasResolver(input);
  const index = new SpatialObstacleIndex(
    input,
    input.traces!,
    undefined,
    [],
    resolver,
  );
  const uniqueAliases = new Set(
    index.items.map((item) => item.connectionNames),
  );
  expect(index.items.length).toBeGreaterThan(200);
  expect(uniqueAliases.size).toBe(2);
  for (const names of uniqueAliases) {
    expect(names).toHaveLength(128);
    expect(resolver.canonicalizations.get(names)).toBe(1);
    // Connected-pad metadata has one additional lookup. Geometry resolution
    // remains one lookup for the entire object, including its route's via.
    expect(resolver.setLookups.get(names)).toBe(names === aliases ? 2 : 1);
  }
  expect(resolver.canonicalizations.size).toBe(2);
  const beforeQueryLookups = [...resolver.canonicalizations.values()];

  const query: CollisionQuery = {
    start: { x: -1, y: -3 },
    end: { x: 1, y: -3 },
    layer: "top",
    width: 0.15,
    connectionNames: [aliases.at(-1)!],
  };
  expect(index.collides(query)).toBe(false);
  expect(index.collides({ ...query, connectionNames: ["SIGNAL"] })).toBe(true);
  expect(
    index.collides({ ...query, layer: "bottom", connectionNames: ["SIGNAL"] }),
  ).toBe(false);
  const viaQuery = { ...query, start: { x: 10, y: -3 }, end: { x: 10, y: -3 } };
  expect(index.collides({ ...viaQuery, layer: "bottom" })).toBe(false);
  expect(
    index.collides({
      ...viaQuery,
      layer: "bottom",
      connectionNames: ["SIGNAL"],
    }),
  ).toBe(true);

  const svg = aliasIndexSnapshot(
    [
      drawAliasIndex({
        input,
        notes: [
          "One power region and one routed trace",
          "128 net aliases per object",
          "Via belongs to the same trace alias list",
        ],
      }),
      drawAliasIndex({
        input,
        items: index.items,
        notes: [
          `${index.items.length} collision rectangles; ${uniqueAliases.size} alias lists`,
          `${beforeQueryLookups.reduce((a, b) => a + b, 0)} canonicalizations for the entire build`,
          "Same copper, layers and net exemptions",
        ],
      }),
    ],
    ["Copper geometry", "Shared aliases in the spatial index"],
  );
  await expect(svg).toMatchSvgSnapshot(import.meta.path);
});
