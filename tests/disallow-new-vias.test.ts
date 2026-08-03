import { expect, test } from "bun:test";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { PowerTraceExpanderSolver } from "../src";

test("does not introduce vias when new vias are disabled", () => {
  const input = structuredClone(simplifiedCases.layerChangeWithNecking);
  const inputViaCount = input.traces!.flatMap((trace) => trace.route).filter(
    (point) => point.route_type === "via",
  ).length;
  const solver = new PowerTraceExpanderSolver(input, { allowNewVias: false });

  solver.solve();

  const outputViaCount = solver
    .getOutput()
    .flatMap((trace) => trace.route)
    .filter((point) => point.route_type === "via").length;
  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.attemptedLayerGridCount).toBe(0);
  expect(solver.insertedViaCount).toBe(0);
  expect(outputViaCount).toBeLessThanOrEqual(inputViaCount);
});
