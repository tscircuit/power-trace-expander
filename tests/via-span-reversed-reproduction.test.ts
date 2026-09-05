import { expect, test } from "bun:test";
import "graphics-debug/matcher";
import { PowerTraceExpanderSolver, SpatialObstacleIndex } from "../src";
import { createViaSpanProblem } from "../fixtures/via-span-obstacles/createViaSpanProblem";
import { getViaSpanGraphics } from "../fixtures/via-span-obstacles/getViaSpanGraphics";

test("keeps power straight outside the via span for reversed endpoints", async (): Promise<void> => {
  const input = createViaSpanProblem("reversed");
  const before = structuredClone(input);
  const solver = new PowerTraceExpanderSolver(input, { allowNewVias: false });
  solver.solve();
  const output = solver.getOutput();
  const index = new SpatialObstacleIndex(input, []);
  const traceLayer = input.connections[0]!.pointsToConnect[0]!.layer;

  expect(solver.solved).toBe(true);
  expect(index.items.find((item) => item.kind === "via")!.layers).toEqual([
    "top",
    "inner1",
    "inner2",
  ]);
  expect(output[0]!.route[0]).toMatchObject({ x: -2, y: 0.5 });
  expect(output[0]!.route.at(-1)).toMatchObject({ x: 2, y: 0.5 });
  expect(
    output[0]!.route.every(
      (point) =>
        point.route_type === "wire" &&
        point.layer === traceLayer &&
        point.y === 0.5 &&
        point.width === 0.8,
    ),
  ).toBe(true);
  expect(input).toEqual(before);
  await expect(
    getViaSpanGraphics(input, output, "reversed"),
  ).toMatchGraphicsSvg(import.meta.path);
});
