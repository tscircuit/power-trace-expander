import { expect, test } from "bun:test";
import { PowerTraceExpanderSolver, type PowerTraceExpanderInput } from "../src";

test("separate top and bottom SMT pads do not provide a through-hole transition", () => {
  const input: PowerTraceExpanderInput = {
    bounds: { minX: -10, maxX: 10, minY: -1, maxY: 1 },
    layerCount: 2,
    minTraceWidth: 0.2,
    minTraceToPadEdgeClearance: 0.1,
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 1,
        pointsToConnect: [
          { x: -8, y: 0, layer: "top" },
          { x: 8, y: 0, layer: "top" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        center: { x: -8, y: 0 },
        width: 1.2,
        height: 1.2,
        layers: ["top"],
        connectedTo: ["POWER"],
      },
      {
        type: "rect",
        center: { x: -8, y: 0 },
        width: 1.2,
        height: 1.2,
        layers: ["bottom"],
        connectedTo: ["POWER"],
      },
      {
        type: "rect",
        center: { x: 8, y: 0 },
        width: 1.2,
        height: 1.2,
        layers: ["top", "bottom"],
        connectedTo: ["POWER"],
      },
      {
        type: "rect",
        center: { x: 0, y: 0.8 },
        width: 2,
        height: 1.2,
        layers: ["top"],
        connectedTo: [],
      },
      {
        type: "rect",
        center: { x: 0, y: -0.8 },
        width: 2,
        height: 1.2,
        layers: ["top"],
        connectedTo: [],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "power",
        connection_name: "POWER",
        route: [
          { route_type: "wire", x: -8, y: 0, width: 0.2, layer: "top" },
          { route_type: "wire", x: 8, y: 0, width: 0.2, layer: "top" },
        ],
      },
    ],
  };
  const solver = new PowerTraceExpanderSolver(input, { allowNewVias: false });
  solver.solve();

  expect(solver.solved).toBe(true);
  const route = solver.getOutput()[0]!.route;
  expect(route[0]).toMatchObject({ x: -8, y: 0, layer: "top" });
  expect(
    route.every(
      (point) => point.route_type === "wire" && point.layer === "top",
    ),
  ).toBe(true);
});
