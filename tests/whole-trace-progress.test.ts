import { expect, test } from "bun:test";
import { PowerTraceExpanderSolver, type PowerTraceExpanderInput } from "../src";

test("whole-trace recovery keeps progress monotonic", () => {
  const input: PowerTraceExpanderInput = {
    layerCount: 1,
    minTraceWidth: 0.15,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    obstacles: [],
    connections: [
      {
        name: "A",
        nominalTraceWidth: 1,
        pointsToConnect: [
          { x: -2, y: 0, layer: "top" },
          { x: 2, y: 0, layer: "top" },
        ],
      },
      {
        name: "B",
        nominalTraceWidth: 1,
        pointsToConnect: [
          { x: -2, y: 2, layer: "top" },
          { x: 2, y: 2, layer: "top" },
        ],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "a",
        connection_name: "A",
        route: [
          { route_type: "wire", x: -2, y: 0, width: 1, layer: "top" },
          { route_type: "wire", x: 2, y: 0, width: 1, layer: "top" },
        ],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "b",
        connection_name: "B",
        route: [
          { route_type: "wire", x: -2, y: 2, width: 1, layer: "top" },
          { route_type: "wire", x: 2, y: 2, width: 1, layer: "top" },
        ],
      },
    ],
  };
  const solver = new PowerTraceExpanderSolver(input);
  let previousProgress = solver.progress;
  while (!solver.solved && !solver.failed) {
    solver.step();
    expect(solver.progress).toBeGreaterThanOrEqual(previousProgress);
    previousProgress = solver.progress;
  }
  expect(solver.solved).toBe(true);
});
