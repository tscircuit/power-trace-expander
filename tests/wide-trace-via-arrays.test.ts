import { expect, test } from "bun:test";
import {
  addViaArraysToWideTraces,
  PowerTraceExpanderSolver,
  type PowerTraceExpanderInput,
} from "../src";

const wire = (
  x: number,
  y: number,
  width: number,
  layer: "top" | "bottom",
) => ({ route_type: "wire" as const, x, y, width, layer });

const createInput = (): PowerTraceExpanderInput => ({
  layerCount: 2,
  minTraceWidth: 0.15,
  nominalTraceWidth: 1,
  minViaPadDiameter: 0.3,
  minViaHoleDiameter: 0.2,
  defaultObstacleMargin: 0.1,
  bounds: { minX: -3, maxX: 3, minY: -2, maxY: 2 },
  obstacles: [],
  connections: [
    {
      name: "POWER",
      nominalTraceWidth: 1,
      pointsToConnect: [
        { x: -2, y: 0, layer: "top" },
        { x: 2, y: 0, layer: "bottom" },
      ],
    },
  ],
  traces: [
    {
      type: "pcb_trace",
      pcb_trace_id: "power",
      connection_name: "POWER",
      route: [
        wire(-2, 0, 1, "top"),
        wire(0, 0, 1, "top"),
        {
          route_type: "via",
          x: 0,
          y: 0,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.3,
          via_hole_diameter: 0.2,
        },
        wire(0, 0, 1, "bottom"),
        wire(2, 0, 1, "bottom"),
      ],
    },
  ],
});

test("adds a clearance-safe via row across a wide layer transition", () => {
  const input = createInput();
  const result = addViaArraysToWideTraces({
    simpleRouteJson: input,
    traces: input.traces!,
  });
  const vias = result.traces[0]!.route.filter(
    (point) => point.route_type === "via",
  );

  expect(vias.map(({ x, y }) => ({ x, y }))).toEqual([
    { x: 0, y: -0.35 },
    { x: 0, y: 0.35 },
  ]);
  expect(result.addedViaArrayCount).toBe(1);
  expect(result.addedViaCount).toBe(1);
  expect(input.traces![0]!.route).toHaveLength(5);
});

test("keeps the original via when an array would violate clearance", () => {
  const input = createInput();
  input.connections.push({
    name: "SIGNAL",
    nominalTraceWidth: 0.15,
    pointsToConnect: [
      { x: -1, y: 0.35, layer: "bottom" },
      { x: 1, y: 0.35, layer: "bottom" },
    ],
  });
  input.traces!.push({
    type: "pcb_trace",
    pcb_trace_id: "signal",
    connection_name: "SIGNAL",
    route: [wire(-1, 0.35, 0.15, "bottom"), wire(1, 0.35, 0.15, "bottom")],
  });

  const result = addViaArraysToWideTraces({
    simpleRouteJson: input,
    traces: input.traces!,
    traceIndices: [0],
  });
  const vias = result.traces[0]!.route.filter(
    (point) => point.route_type === "via",
  );

  expect(vias).toHaveLength(1);
  expect(vias[0]).toMatchObject({ x: 0, y: 0 });
  expect(result.addedViaArrayCount).toBe(0);
  expect(result.skippedViaArrayCount).toBe(1);
});

test("rotates the row to avoid a connected pad", () => {
  const input = createInput();
  input.obstacles.push({
    type: "rect",
    center: { x: 0, y: -0.575 },
    width: 0.5,
    height: 0.25,
    layers: ["top"],
    connectedTo: ["pcb_smtpad_power", "POWER"],
  });

  const result = addViaArraysToWideTraces({
    simpleRouteJson: input,
    traces: input.traces!,
    traceIndices: [0],
  });
  const vias = result.traces[0]!.route.filter(
    (point) => point.route_type === "via",
  );

  expect(vias).toHaveLength(2);
  expect(vias.map(({ x, y }) => ({ x, y }))).not.toEqual([
    { x: 0, y: -0.35 },
    { x: 0, y: 0.35 },
  ]);
  expect(result.addedViaArrayCount).toBe(1);
  expect(result.skippedViaArrayCount).toBe(0);
});

test("adds via arrays at the end of power-trace expansion when enabled", () => {
  const input = createInput();
  const solver = new PowerTraceExpanderSolver(input, {
    addViaArrays: true,
    allowNewVias: false,
  });

  solver.solve();

  const vias = solver
    .getOutput()[0]!
    .route.filter((point) => point.route_type === "via");
  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(vias).toHaveLength(2);
  expect(solver.stats.addedViaArrayCount).toBe(1);
  expect(solver.stats.addedArrayViaCount).toBe(1);
});
