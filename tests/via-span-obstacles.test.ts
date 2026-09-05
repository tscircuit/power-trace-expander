import { expect, test } from "bun:test";
import { SpatialObstacleIndex } from "../src";
import type { PowerTraceExpanderInput, ViaRoutePoint } from "../src/types";

test("via obstacles occupy their inclusive endpoint span", () => {
  const via: ViaRoutePoint = {
    route_type: "via",
    x: 0,
    y: 0,
    from_layer: "inner2",
    to_layer: "top",
    via_diameter: 0.3,
  };
  const input = {
    layerCount: 4,
    minTraceWidth: 0.1,
    bounds: { minX: -2, minY: -2, maxX: 2, maxY: 2 },
    obstacles: [],
    connections: [],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "via",
        connection_name: "VIA",
        route: [via],
      },
    ],
  } satisfies PowerTraceExpanderInput;
  const collidesOnLayer = (layer: string): boolean => {
    const index = new SpatialObstacleIndex(input, input.traces);
    return index.collides({
      start: { x: -1, y: 0 },
      end: { x: 1, y: 0 },
      layer,
      width: 0.1,
      connectionNames: ["SIGNAL"],
    });
  };

  expect(collidesOnLayer("inner1")).toBe(true);
  expect(collidesOnLayer("bottom")).toBe(false);

  via.from_layer = "bottom";
  via.to_layer = "bottom";
  expect(collidesOnLayer("bottom")).toBe(true);
  expect(collidesOnLayer("inner1")).toBe(false);
  expect(via.from_layer).toBe("bottom");
  expect(via.to_layer).toBe("bottom");
});
