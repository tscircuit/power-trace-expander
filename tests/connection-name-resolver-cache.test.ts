import { expect, test } from "bun:test";
import { ConnectionNameResolver, type PowerTraceExpanderInput } from "../src";

test("caches canonical names by stable input-array identity", () => {
  const input = {
    layerCount: 2,
    minTraceWidth: 0.15,
    bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
    obstacles: [],
    connections: [
      {
        name: "POWER",
        source_trace_id: "power_alias",
        pointsToConnect: [],
      },
    ],
    traces: [],
  } satisfies PowerTraceExpanderInput;
  const resolver = new ConnectionNameResolver(input);
  const names = ["POWER", "power_alias"];
  const resolverInternals = resolver as unknown as {
    find: (name: string) => string;
  };
  const find = resolverInternals.find.bind(resolver);
  let findCallCount = 0;
  resolverInternals.find = (name: string): string => {
    findCallCount++;
    return find(name);
  };

  const firstResult = resolver.canonicalize(names);
  const firstFindCallCount = findCallCount;
  firstResult.push("caller_mutation");
  const secondResult = resolver.canonicalize(names);

  expect(firstFindCallCount).toBeGreaterThan(0);
  expect(findCallCount).toBe(firstFindCallCount);
  expect(secondResult).toEqual(["POWER"]);
  expect(secondResult).not.toBe(firstResult);

  names.push("unrelated");
  const resultAfterInputMutation = resolver.canonicalize(names);

  expect(findCallCount).toBeGreaterThan(firstFindCallCount);
  expect(resultAfterInputMutation).toEqual(["POWER", "unrelated"]);
});
