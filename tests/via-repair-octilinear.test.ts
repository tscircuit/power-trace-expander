import { expect, test } from "bun:test";
import "bun-match-svg";
import { getSvgFromGraphicsObject } from "graphics-debug";
import { PowerTraceCleanupSolver } from "../src/PowerTraceCleanupSolver";
import { isOctilinearSegment } from "../src/octilinear";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "../src/types";

test("relocating a via preserves native headings on both clearance-checked arms", async (): Promise<void> => {
  const trace: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: "power_route",
    connection_name: "power",
    route: [
      { route_type: "wire", x: -5, y: -5, layer: "top", width: 0.1 },
      { route_type: "wire", x: 0, y: 0, layer: "top", width: 0.1 },
      {
        route_type: "via",
        x: 0,
        y: 0,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: 0.35,
        via_hole_diameter: 0.15,
      },
      { route_type: "wire", x: 0, y: 0, layer: "bottom", width: 0.1 },
      { route_type: "wire", x: 6, y: 0, layer: "bottom", width: 0.1 },
    ],
  };
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    bounds: { minX: -8, maxX: 8, minY: -8, maxY: 8 },
    connections: [
      {
        name: "power",
        nominalTraceWidth: 0.1,
        pointsToConnect: [
          { x: -5, y: -5, layer: "top" },
          { x: 6, y: 0, layer: "bottom" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        shape: "circle",
        center: { x: 0, y: 0 },
        width: 0.4,
        height: 0.4,
        layers: ["top", "inner1", "inner2", "bottom"],
        connectedTo: ["other_pad"],
      },
    ],
  };
  const solver = new PowerTraceCleanupSolver({
    simpleRouteJson: input,
    traces: [trace],
  });
  solver.solve();
  expect(solver.solved).toBe(true);
  expect(solver.relocatedViaCount).toBe(1);
  const output = solver.getOutput()[0]!;
  expect(output.route[0]).toEqual(trace.route[0]);
  expect(output.route.at(-1)).toEqual(trace.route.at(-1));
  for (let index = 1; index < output.route.length; index++) {
    const start = output.route[index - 1]!,
      end = output.route[index]!;
    if (
      start.route_type === "wire" &&
      end.route_type === "wire" &&
      start.layer === end.layer
    )
      expect(isOctilinearSegment(start, end)).toBe(true);
  }
  await expect(
    getSvgFromGraphicsObject(solver.visualize(), { backgroundColor: "white" }),
  ).toMatchSvgSnapshot(import.meta.path);
});
