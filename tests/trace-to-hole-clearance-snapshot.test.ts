import { expect, test } from "bun:test";
import "bun-match-svg";
import {
  getSvgFromGraphicsObject,
  stackGraphicsHorizontally,
  type GraphicsObject,
} from "graphics-debug";
import { PowerTraceExpanderSolver } from "../src";
import { distancePointToSegment } from "../src/geometry";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "../src/types";

const input: SimpleRouteJson = {
  layerCount: 2,
  minTraceWidth: 0.15,
  nominalTraceWidth: 0.8,
  minTraceToPadEdgeClearance: 0.1,
  bounds: { minX: -4, maxX: 4, minY: -3, maxY: 3 },
  obstacles: [-1.5, 1.5].map((y) => ({
    type: "rect",
    isNonPlatedHole: true,
    shape: "circle",
    center: { x: 0, y },
    width: 2,
    height: 2,
    layers: ["top", "bottom"],
    connectedTo: [],
  })),
  connections: [
    {
      name: "POWER",
      nominalTraceWidth: 0.8,
      pointsToConnect: [
        { x: -3, y: 0, layer: "top" },
        { x: 3, y: 0, layer: "top" },
      ],
    },
  ],
  traces: [
    {
      type: "pcb_trace",
      pcb_trace_id: "power",
      connection_name: "POWER",
      route: [
        { route_type: "wire", x: -3, y: 0, width: 0.15, layer: "top" },
        { route_type: "wire", x: 3, y: 0, width: 0.15, layer: "top" },
      ],
    },
  ],
};

function drawTrace(trace: SimplifiedPcbTrace, color: string): GraphicsObject {
  return {
    coordinateSystem: "cartesian",
    rects: [
      {
        center: { x: 0, y: 0 },
        width: 8,
        height: 6,
        fill: "transparent",
        stroke: "#cbd5e1",
      },
    ],
    circles: input.obstacles.map((hole) => ({
      center: hole.center,
      radius: hole.width / 2,
      fill: "#e2e8f0",
      stroke: "#475569",
    })),
    lines: trace.route.slice(1).flatMap((end, index) => {
      const start = trace.route[index]!;
      if (start.route_type !== "wire" || end.route_type !== "wire") return [];
      return [
        { points: [start, end], strokeWidth: start.width, strokeColor: color },
      ];
    }),
  };
}

test("power expansion keeps a narrower neck as hole clearance increases", async () => {
  const before = structuredClone(input);
  const panels = [drawTrace(input.traces![0]!, "#64748b")];
  const neckWidths: number[] = [];
  for (const clearance of [0, 0.2, 0.4]) {
    const problem = { ...input, minTraceToHoleEdgeClearance: clearance };
    const solver = new PowerTraceExpanderSolver(problem, {
      allowNewVias: false,
    });
    solver.solve();
    expect(solver.solved).toBe(true);
    expect(solver.failed).toBe(false);
    const output = solver.getOutput();
    expect(output).toHaveLength(1);
    const trace = output[0]!;
    expect(trace.connection_name).toBe("POWER");
    expect(trace.route[0]).toMatchObject({ x: -3, y: 0, layer: "top" });
    expect(trace.route.at(-1)).toMatchObject({ x: 3, y: 0, layer: "top" });
    expect(trace.route.every((point) => point.route_type === "wire")).toBe(
      true,
    );
    let neckWidth = Infinity;
    for (let i = 1; i < trace.route.length; i++) {
      const start = trace.route[i - 1]!;
      const end = trace.route[i]!;
      if (start.route_type !== "wire" || end.route_type !== "wire") continue;
      neckWidth = Math.min(neckWidth, start.width);
      expect(start.width).toBeGreaterThanOrEqual(input.minTraceWidth);
      for (const hole of input.obstacles) {
        const gap =
          distancePointToSegment(hole.center, start, end) -
          hole.width / 2 -
          start.width / 2;
        expect(gap).toBeGreaterThanOrEqual(clearance - 1e-8);
      }
    }
    expect(neckWidth).toBeGreaterThan(input.minTraceWidth);
    neckWidths.push(neckWidth);
    panels.push({
      ...drawTrace(trace, "#2563eb"),
      texts: [
        {
          x: 0,
          y: -2.8,
          text: `Neck width: ${neckWidth.toFixed(3)} mm`,
          fontSize: 0.25,
        },
      ],
    });
  }
  expect(neckWidths[0]).toBeCloseTo(input.nominalTraceWidth!, 8);
  expect(neckWidths[0]!).toBeGreaterThan(neckWidths[1]!);
  expect(neckWidths[1]!).toBeGreaterThan(neckWidths[2]!);
  expect(input).toEqual(before);
  const svg = getSvgFromGraphicsObject(
    stackGraphicsHorizontally(panels, {
      titles: [
        "Input: 0.15 mm trace",
        "0.0 mm clearance",
        "0.2 mm clearance",
        "0.4 mm clearance",
      ],
    }),
    { backgroundColor: "white", svgWidth: 1400, svgHeight: 380 },
  );
  await expect(svg).toMatchSvgSnapshot(import.meta.path);
});
