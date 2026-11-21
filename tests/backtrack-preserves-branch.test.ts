import { expect, test } from "bun:test";
import { removeUnusedTraceBacktracks } from "../src/removeUnusedTraceBacktracks";
import type { PowerTraceExpanderInput, SimplifiedPcbTrace } from "../src/types";

test("backtrack removal preserves a useful junction, changed widths and immutable routes", (): void => {
  const input: PowerTraceExpanderInput = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -2, maxX: 3, minY: -2, maxY: 2 },
    obstacles: [],
    connections: [
      {
        name: "GND",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 1, y: 1, layer: "top" },
          { x: 2, y: 1, layer: "top" },
        ],
      },
    ],
  };
  const wire = (x: number, y: number) => ({
    route_type: "wire" as const,
    x,
    y,
    layer: "top",
    width: 0.1,
  });
  const traces: SimplifiedPcbTrace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "main",
      connection_name: "GND",
      route: [wire(0, 0), wire(2, 0), wire(1, 0), wire(1, 1)],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "branch",
      connection_name: "GND",
      route: [wire(2, 0), wire(2, 1)],
    },
  ];
  expect(
    removeUnusedTraceBacktracks(input, traces, new Set()).removedCount,
  ).toBe(0);
  const withoutBranch = {
    ...input,
    connections: [
      {
        ...input.connections[0]!,
        pointsToConnect: input.connections[0]!.pointsToConnect.slice(0, 2),
      },
    ],
  };
  expect(
    removeUnusedTraceBacktracks(withoutBranch, traces.slice(0, 1), new Set())
      .removedCount,
  ).toBe(1);
  expect(
    removeUnusedTraceBacktracks(withoutBranch, traces.slice(0, 1), new Set([0]))
      .removedCount,
  ).toBe(0);
  const wider = structuredClone(traces[0]!);
  const corner = wider.route[1]!;
  if (corner.route_type !== "wire") throw new Error("Expected wire corner");
  corner.width = 0.2;
  expect(
    removeUnusedTraceBacktracks(withoutBranch, [wider], new Set()).removedCount,
  ).toBe(0);
});
