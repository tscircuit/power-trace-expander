import { expect, test } from "bun:test";
import "graphics-debug/matcher";
import {
  PowerTraceCleanupSolver,
  PowerTraceClearanceRepairSolver,
  SpatialObstacleIndex,
  type PowerTraceExpanderInput,
} from "../src";

test("cleanup widens a terminal escape and confines its neck to the pad", async () => {
  const input = {
    layerCount: 2,
    minTraceWidth: 0.15,
    bounds: { minX: -2, minY: -1, maxX: 1, maxY: 2.5 },
    obstacles: [
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 1,
        height: 0.75,
        layers: ["top"],
        connectedTo: ["pcb_smtpad_start", "POWER"],
      },
    ],
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 1,
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: -0.856, y: 1.603, layer: "top" },
        ],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "power",
        connection_name: "POWER",
        route: [
          { route_type: "wire", x: 0, y: 0, width: 0.15, layer: "top" },
          { route_type: "wire", x: 0, y: 0.776, width: 0.15, layer: "top" },
          {
            route_type: "wire",
            x: -0.688,
            y: 1.465,
            width: 0.15,
            layer: "top",
          },
          {
            route_type: "wire",
            x: -0.717,
            y: 1.465,
            width: 0.15,
            layer: "top",
          },
          {
            route_type: "wire",
            x: -0.856,
            y: 1.603,
            width: 0.15,
            layer: "top",
          },
        ],
      },
    ],
  } satisfies PowerTraceExpanderInput;
  const cleanup = new PowerTraceCleanupSolver({
    simpleRouteJson: input,
    traces: input.traces,
  });
  cleanup.solve();
  expect(cleanup.solved).toBe(true);
  expect(cleanup.getOutput()[0]!.route[0]).toMatchObject({ width: 1 });

  const repair = new PowerTraceClearanceRepairSolver({
    simpleRouteJson: input,
    traces: cleanup.getOutput(),
  });
  repair.solve();
  expect(repair.solved).toBe(true);
  const output = repair.getOutput();
  const wires = output[0]!.route.filter((point) => point.route_type === "wire");
  expect(wires[0]!.width).toBe(0.75);
  expect(wires[1]!.y).toBeCloseTo(0.375, 5);
  expect(wires[2]!.y).toBeCloseTo(0.375, 5);
  expect(wires[2]!.width).toBe(1);
  expect(wires[3]!.width).toBe(1);

  const index = new SpatialObstacleIndex(input, output);
  expect(
    index.collides({
      start: wires[2]!,
      end: wires[3]!,
      layer: "top",
      width: 1,
      connectionNames: ["POWER"],
      ignoreTraceIndex: 0,
    }),
  ).toBe(false);
  await expect(repair.visualize()).toMatchGraphicsSvg(import.meta.path);
});
