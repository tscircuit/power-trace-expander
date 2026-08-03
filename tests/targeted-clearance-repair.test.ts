import { expect, test } from "bun:test";
import { PowerTraceExpanderSolver, type PowerTraceExpanderInput } from "../src";

const wire = (x: number, y: number, width: number) => ({
  route_type: "wire" as const,
  x,
  y,
  width,
  layer: "top",
});

test("targeted expansion leaves non-selected signal clearance transitions byte-for-byte", () => {
  const input: PowerTraceExpanderInput = {
    layerCount: 2,
    minTraceWidth: 0.15,
    nominalTraceWidth: 1,
    defaultObstacleMargin: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    minViaHoleDiameter: 0.2,
    minViaPadDiameter: 0.3,
    bounds: { minX: 9, maxX: 15, minY: -4, maxY: 1 },
    obstacles: [],
    connections: [
      {
        name: "POWER",
        nominalTraceWidth: 1,
        pointsToConnect: [
          { x: 13, y: 0, layer: "top" },
          { x: 14, y: 0, layer: "top" },
        ],
      },
      {
        name: "SIGNAL_A",
        nominalTraceWidth: 0.25,
        pointsToConnect: [
          { x: 11.360820734793128, y: -2.365910377208615, layer: "top" },
          { x: 11.360820734793128, y: -2.8141792652068713, layer: "top" },
        ],
      },
      {
        name: "SIGNAL_B",
        nominalTraceWidth: 0.25,
        pointsToConnect: [
          { x: 10.675134, y: -2.3248660000000005, layer: "top" },
          { x: 11.4, y: -1.6, layer: "top" },
        ],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "power",
        connection_name: "POWER",
        route: [wire(13, 0, 1), wire(14, 0, 1)],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "signal-a",
        connection_name: "SIGNAL_A",
        route: [
          wire(11.360820734793128, -2.365910377208615, 0.175),
          wire(11.360820734793128, -2.8141792652068713, 0.65),
        ],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "signal-b",
        connection_name: "SIGNAL_B",
        route: [
          wire(10.675134, -2.3248660000000005, 0.25),
          wire(11.4, -1.6, 0.25),
        ],
      },
    ],
  };
  const originalSignals = structuredClone(input.traces!.slice(1));
  const solver = new PowerTraceExpanderSolver(input, {
    onlyConnectionNames: ["POWER"],
  });

  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.stats.selectedTraceCount).toBe(1);
  expect(solver.getOutput().slice(1)).toEqual(originalSignals);
});
