import { expect, test } from "bun:test";
import "bun-match-svg";
import { getSvgFromGraphicsObject } from "graphics-debug";
import {
  measureTraceWidths,
  PowerTraceExpanderSolver,
  type PowerTraceExpanderInput,
} from "../src";
import type { SimplifiedPcbTrace } from "../src/types";

test("a shared net loses its supply branch's requested width", async () => {
  const wire = (x: number, y = 0) => ({
    route_type: "wire" as const,
    x,
    y,
    width: 0.15,
    layer: "top",
  });
  const traces: Array<SimplifiedPcbTrace & { nominalTraceWidth: number }> = [
    {
      type: "pcb_trace",
      pcb_trace_id: "sense",
      connection_name: "SENSE_ALIAS",
      nominalTraceWidth: 0.15,
      route: [wire(0), wire(3)],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "supply",
      connection_name: "SENSE_ALIAS",
      nominalTraceWidth: 0.8,
      route: [wire(-3), wire(0)],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "imported",
      connection_name: "IMPORTED",
      nominalTraceWidth: 0.8,
      route: [wire(-3, 2), wire(3, 2)],
    },
  ];
  const input: PowerTraceExpanderInput = {
    layerCount: 1,
    minTraceWidth: 0.1,
    bounds: { minX: -4, minY: -3, maxX: 4, maxY: 3 },
    obstacles: [],
    connections: [
      {
        name: "SENSE_ALIAS",
        nominalTraceWidth: 0.15,
        pointsToConnect: [-3, 0, 3].map((x) => ({ x, y: 0, layer: "top" })),
      },
    ],
    traces,
  };
  const solver = new PowerTraceExpanderSolver(input, { allowNewVias: false });
  solver.solve();

  expect(solver.solved, solver.error ?? "").toBe(true);
  expect(solver.stats.resultStatus).toBe("complete");
  const output = solver.getOutput();
  const [sense, supply, imported] = output;
  expect(sense).toEqual(traces[0]);
  const supplyWires = supply!.route.filter(
    (point) => point.route_type === "wire",
  );
  expect(supplyWires.length).toBeGreaterThanOrEqual(2);
  expect(new Set(supplyWires.map((point) => point.width))).toEqual(
    new Set([0.15]),
  );
  expect(imported).toEqual(traces[2]);
  expect([...measureTraceWidths(input, output).keys()]).toEqual([0.15]);
  const graphics = solver.visualize();
  graphics.texts = [
    {
      x: -1.5,
      y: -0.4,
      text: `Supply · ${supplyWires[0]!.width} of ${traces[1]!.nominalTraceWidth.toFixed(2)} mm`,
      fontSize: 0.22,
    },
    { x: 1.5, y: -0.4, text: "Sense · 0.15 mm", fontSize: 0.22 },
    { x: 0, y: 2.35, text: "Imported copper", fontSize: 0.22 },
  ];
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 580,
      svgHeight: 290,
    }),
  ).toMatchSvgSnapshot(import.meta.path);
});
