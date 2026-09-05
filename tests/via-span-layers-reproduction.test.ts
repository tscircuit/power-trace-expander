import { expect, test } from "bun:test";
import "graphics-debug/matcher";
import { PowerTraceExpanderSolver, SpatialObstacleIndex } from "../src";
import { createViaSpanProblem } from "../fixtures/via-span-obstacles/createViaSpanProblem";
import { getViaSpanGraphics } from "../fixtures/via-span-obstacles/getViaSpanGraphics";

test("reproduces the false via obstacle for layers", async (): Promise<void> => {
  const input = createViaSpanProblem("layers");
  const before = structuredClone(input);
  const solver = new PowerTraceExpanderSolver(input, { allowNewVias: false });
  solver.solve();
  const output = solver.getOutput();
  const index = new SpatialObstacleIndex(input, []);
  const traceLayer = input.connections[0]!.pointsToConnect[0]!.layer;

  expect(solver.solved).toBe(true);
  // Capture the current bug: an unrelated layer blocks expansion.
  expect(index.items.find((item) => item.kind === "via")!.layers).toContain(
    traceLayer,
  );
  expect(
    output[0]!.route.some(
      (point) => point.route_type === "wire" && point.y > 0.5 + 1e-6,
    ),
  ).toBe(true);
  expect(input).toEqual(before);
  await expect(getViaSpanGraphics(input, output, "layers")).toMatchGraphicsSvg(
    import.meta.path,
  );
});
