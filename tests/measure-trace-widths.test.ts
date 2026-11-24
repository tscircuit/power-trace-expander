import { expect, test } from "bun:test";
import { measureTraceWidths } from "../src/measureTraceWidths";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "../src/types";

test("via-only traces use the neutral nominal width percentile fallback", () => {
  const problem: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.2,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    connections: [
      {
        name: "power",
        nominalTraceWidth: 1,
        pointsToConnect: [],
      },
    ],
    obstacles: [],
  };
  const trace: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: "via_only_power",
    connection_name: "power",
    route: [
      {
        route_type: "via",
        x: 0,
        y: 0,
        from_layer: "top",
        to_layer: "bottom",
      },
    ],
  };

  const metric = measureTraceWidths(problem, [trace]).get(1)!;

  expect(metric.totalLength).toBe(0);
  expect(metric.averageWidth).toBe(1);
  expect(metric.minimumWidth).toBe(1);
  expect(metric.p05Width).toBe(1);
  expect(metric.p10Width).toBe(1);
});
