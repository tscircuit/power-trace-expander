import { expect, test } from "bun:test";
import {
  ConnectionNameResolver,
  SpatialObstacleIndex,
  type PowerTraceExpanderInput,
} from "../src";
import type { CollisionQuery } from "../src/types";

class CountingConnectionNameResolver extends ConnectionNameResolver {
  readonly callsByAliases = new Map<string[], number>();

  override canonicalizeToSet(names: string[]): ReadonlySet<string> {
    this.callsByAliases.set(names, (this.callsByAliases.get(names) ?? 0) + 1);
    return super.canonicalizeToSet(names);
  }
}

test("shares resolved aliases across copper rectangles and refreshes them on rebuild", () => {
  const padNames = ["pcb_smtpad_1", "POWER"];
  const input: PowerTraceExpanderInput = {
    layerCount: 2,
    minTraceWidth: 0.15,
    bounds: { minX: -20, minY: -20, maxX: 20, maxY: 20 },
    connections: [
      { name: "POWER", source_trace_id: "power-alias", pointsToConnect: [] },
    ],
    obstacles: [
      {
        type: "rect",
        center: { x: 0, y: 5 },
        width: 6,
        height: 6,
        layers: ["top"],
        connectedTo: padNames,
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "power-trace",
        connection_name: "POWER",
        route: [
          { route_type: "wire", x: -10, y: 0, layer: "top", width: 0.15 },
          { route_type: "wire", x: 10, y: 0, layer: "top", width: 0.15 },
          {
            route_type: "via",
            x: 10,
            y: 0,
            from_layer: "top",
            to_layer: "bottom",
          },
        ],
      },
    ],
  };
  const resolver = new CountingConnectionNameResolver(input);
  const index = new SpatialObstacleIndex(
    input,
    input.traces!,
    undefined,
    [],
    resolver,
  );
  expect(index.items.length).toBeGreaterThan(100);
  // Ignore the connected-pad metadata call; each geometry alias array should
  // be resolved only once, independent of the number of copper rectangles.
  const traceNames = index.items.find(
    (item) => item.kind === "trace",
  )!.connectionNames;
  expect(resolver.callsByAliases.get(traceNames)).toBe(1);
  expect(resolver.callsByAliases.get(padNames)).toBe(2);

  const query: CollisionQuery = {
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
    layer: "top",
    width: 0.15,
    connectionNames: ["power-alias"],
  };
  expect(index.collides(query)).toBe(false);
  expect(index.collides({ ...query, connectionNames: ["SIGNAL"] })).toBe(true);
  const padQuery = { ...query, start: { x: 0, y: 5 }, end: { x: 1, y: 5 } };
  expect(index.collides(padQuery)).toBe(false);
  expect(index.collides({ ...padQuery, blockSameNetObstacles: true })).toBe(
    true,
  );
  expect(index.collides({ ...padQuery, connectionNames: ["SIGNAL"] })).toBe(
    true,
  );
  expect(
    index.collides({
      ...padQuery,
      layer: "bottom",
      connectionNames: ["SIGNAL"],
    }),
  ).toBe(false);

  // Reusing a global array cache would retain the old electrical net here.
  padNames.splice(0, padNames.length, "pcb_smtpad_2", "SIGNAL");
  const rebuilt = new SpatialObstacleIndex(input, input.traces!);
  expect(rebuilt.collides(padQuery)).toBe(true);
  expect(rebuilt.collides({ ...padQuery, connectionNames: ["SIGNAL"] })).toBe(
    false,
  );
});
