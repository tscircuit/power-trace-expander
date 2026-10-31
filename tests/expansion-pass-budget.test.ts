import { expect, test } from "bun:test";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { PowerTraceExpanderSolver } from "../src";

test("a one-pass budget completes cleanup and retains committed expansion", () => {
  const input = structuredClone(simplifiedCases.narrowChannelRetreat);
  const solver = new PowerTraceExpanderSolver(input, { maxExpansionPasses: 1 });
  solver.solve();
  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.stats.completedPassCount).toBe(1);
  expect(solver.stats.budgetLimitedExpansion).toBe(false);
  expect(solver.stats.discardedExpansionMutationStats).toBeNull();
  expect(solver.stats.cleanupCompleted).toBe(true);
  expect(solver.stats.clearanceRepairCompleted).toBe(true);
  expect(solver.getOutput()).not.toEqual(input.traces);
  for (const maxExpansionPasses of [0, -1, 1.5, Infinity, NaN]) {
    expect(
      () => new PowerTraceExpanderSolver(input, { maxExpansionPasses }),
    ).toThrow("positive safe integer");
  }
});
