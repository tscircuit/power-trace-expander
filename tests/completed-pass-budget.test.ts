import { expect, test } from "bun:test";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { PowerTraceExpanderSolver } from "../src";

test("budget finalization retains a completed pass and discards the unfinished pass", () => {
  const input = structuredClone(simplifiedCases.narrowChannelRetreat);
  const onePass = new PowerTraceExpanderSolver(input, { maxExpansionPasses: 1 });
  onePass.solve();
  const solver = new PowerTraceExpanderSolver(input);
  while (solver.passIndex === 0 && !solver.solved && !solver.failed) {
    solver.step();
  }
  expect(solver.passIndex).toBe(1);
  expect(solver.expandedSegmentCount).toBeGreaterThan(0);
  const expandedSegments = solver.expandedSegmentCount;
  while (!solver.activeSubSolver && !solver.solved && !solver.failed) {
    solver.step();
  }
  expect(solver.activeSubSolver).not.toBeNull();
  const unfinishedChild = solver.activeSubSolver;
  // An unfinished later pass must not replace the completed pass checkpoint.
  solver.traces[0]!.route = [];
  solver.iterations = Number(solver.stats.expansionIterationBudget) - 1;
  solver.step();
  expect(solver.activeSubSolver).not.toBe(unfinishedChild);
  solver.solve();
  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.budgetLimitedExpansion).toBe(true);
  expect(solver.cleanupCompleted).toBe(true);
  expect(solver.clearanceRepairCompleted).toBe(true);
  expect(solver.connectivityRollbackCount).toBe(0);
  expect(solver.expandedSegmentCount).toBe(expandedSegments);
  expect(solver.getOutput()).toEqual(onePass.getOutput());
  expect(solver.getOutput()).not.toEqual(input.traces);
});
