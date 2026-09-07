import { expect, test } from "bun:test";
import type { PowerTraceClearanceRepairProblem } from "../src/PowerTraceClearanceRepairSolver";
import { PowerTraceClearanceRepairSolver } from "../src/PowerTraceClearanceRepairSolver";
import type { WireRoutePoint } from "../src/types";

const wire = (x: number): WireRoutePoint => ({
  route_type: "wire",
  x,
  y: 0,
  width: 1,
  layer: "top",
});

const scenarios = [
  {
    name: "keeps the exposed neck of an overlapping narrower pad",
    start: 0,
    end: 2,
    pads: [
      { center: { x: 0, y: 0 }, width: 1, height: 0.5 },
      { center: { x: 0.75, y: 0 }, width: 1, height: 0.25 },
    ],
    expectedCopper: [
      [0, 0.5, 0.5],
      [0.5, 1.25, 0.25],
      [1.25, 2, 1],
    ],
  },
  {
    name: "keeps distinct widths on each side of touching pads",
    start: -1,
    end: 1,
    pads: [
      { center: { x: -1, y: 0 }, width: 2, height: 2 },
      { center: { x: 1, y: 0 }, width: 2, height: 0.4 },
    ],
    expectedCopper: [
      [-1, 0, 1],
      [0, 1, 0.4],
    ],
  },
];

for (const scenario of scenarios) {
  for (const reverse of [false, true]) {
    test(`${scenario.name} (${reverse ? "reverse" : "forward"})`, () => {
      const input: PowerTraceClearanceRepairProblem = {
        simpleRouteJson: {
          layerCount: 2,
          minTraceWidth: 0.1,
          defaultObstacleMargin: 0.1,
          bounds: { minX: -3, minY: -3, maxX: 4, maxY: 3 },
          obstacles: scenario.pads.map((pad, index) => ({
            ...pad,
            type: "rect",
            layers: ["top"],
            connectedTo: [`pcb_smtpad_${index}`, "POWER"],
          })),
          connections: [
            {
              name: "POWER",
              nominalTraceWidth: 1,
              pointsToConnect: [
                { x: scenario.start, y: 0, layer: "top" },
                { x: scenario.end, y: 0, layer: "top" },
              ],
            },
          ],
        },
        traces: [
          {
            type: "pcb_trace",
            pcb_trace_id: "overlapping_pad_trace",
            connection_name: "POWER",
            route: reverse
              ? [wire(scenario.end), wire(scenario.start)]
              : [wire(scenario.start), wire(scenario.end)],
          },
        ],
      };
      const before = structuredClone(input);
      const solver = new PowerTraceClearanceRepairSolver(input);
      solver.solve();

      expect(solver.solved).toBe(true);
      expect(solver.failed).toBe(false);
      expect(solver.budgetLimited).toBe(false);
      expect(input).toEqual(before);
      expect(solver.getOutput()).toHaveLength(1);
      const route = solver.getOutput()[0].route;
      expect(route.every((point) => point.route_type === "wire")).toBe(true);
      const wires = route as WireRoutePoint[];
      const copper = wires
        .slice(0, -1)
        .map((start, index) => {
          const end = wires[index + 1];
          expect(start.layer).toBe(end.layer);
          expect(start.y).toBe(0);
          expect(end.y).toBe(0);
          expect(
            Math.hypot(end.x - start.x, end.y - start.y),
          ).toBeGreaterThanOrEqual(0.001);
          return [
            Math.min(start.x, end.x),
            Math.max(start.x, end.x),
            start.width,
          ];
        })
        .sort((left, right) => left[0] - right[0]);

      expect(copper).toEqual(scenario.expectedCopper);
    });
  }
}
