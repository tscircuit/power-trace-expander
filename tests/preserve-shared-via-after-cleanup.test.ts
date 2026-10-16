import { expect, test } from "bun:test";
import { PowerTraceExpanderSolver } from "../src/PowerTraceExpanderSolver";
import type { SimpleRouteJson } from "../src/types";

test("power cleanup preserves one shared drill across branches on different electrical layers", (): void => {
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.15,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    connections: [],
    obstacles: [],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "branch-a",
        connection_name: "ground",
        route: [
          { route_type: "wire", x: 0, y: 0, width: 0.15, layer: "top" },
          { route_type: "wire", x: 1, y: 0, width: 0.15, layer: "top" },
          { route_type: "via", x: 1, y: 0, from_layer: "top", to_layer: "inner1", via_diameter: 0.5, via_hole_diameter: 0.25 },
          { route_type: "wire", x: 1, y: 0, width: 0.15, layer: "inner1" },
          { route_type: "wire", x: 3, y: 1, width: 0.15, layer: "inner1" },
        ],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "branch-b",
        connection_name: "ground",
        route: [
          { route_type: "wire", x: 0, y: 0, width: 0.15, layer: "top" },
          { route_type: "wire", x: 1, y: 0, width: 0.15, layer: "top" },
          { route_type: "via", x: 1, y: 0, from_layer: "top", to_layer: "bottom", via_diameter: 0.5, via_hole_diameter: 0.25 },
          { route_type: "wire", x: 1, y: 0, width: 0.15, layer: "bottom" },
          { route_type: "wire", x: 3, y: -1, width: 0.15, layer: "bottom" },
        ],
      },
    ],
  };
  const solver = new PowerTraceExpanderSolver(input, {
    onlyConnectionNames: ["ground"],
    allowNewVias: false,
  });

  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.getOutput().flatMap((trace) =>
    trace.route.filter((point) => point.route_type === "via")
      .map((point) => ({ x: point.x, y: point.y })),
  )).toEqual([{ x: 1, y: 0 }, { x: 1, y: 0 }]);
});
