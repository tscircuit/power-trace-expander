import { expect, test } from "bun:test";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { PowerTraceExpanderSolver } from "../src";

test("a disconnected completed pass cannot bypass finalization validation", () => {
  const input = structuredClone(simplifiedCases.narrowChannelRetreat);
  const solver = new PowerTraceExpanderSolver(input);
  while (solver.passIndex === 0 && !solver.solved && !solver.failed) {
    solver.step();
  }
  expect(solver.passIndex).toBe(1);
  const checkpoint = (
    solver as unknown as {
      completedExpansionPass: { traces: typeof solver.traces };
    }
  ).completedExpansionPass;
  checkpoint.traces[0]!.route = [];
  solver.iterations = Number(solver.stats.expansionIterationBudget) - 1;
  solver.step();
  expect(solver.connectivityRollbackCount).toBeGreaterThan(0);
  expect(solver.connectivityRollbackPhases).toContain("expansion");
  expect(solver.expandedSegmentCount).toBe(0);
  expect(solver.getOutput()).toEqual(input.traces);
});
