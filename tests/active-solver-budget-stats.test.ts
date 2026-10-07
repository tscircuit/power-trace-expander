import { expect, test } from "bun:test";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { PowerTraceExpanderSolver } from "../src/PowerTraceExpanderSolver";

test("reports a changed iteration budget while a child is still running", (): void => {
  const solver = new PowerTraceExpanderSolver(
    structuredClone(simplifiedCases.narrowChannelRetreat),
  );
  while (
    (!solver.activeSubSolver || solver.activeSubSolver.iterations < 1) &&
    !solver.solved &&
    !solver.failed
  ) {
    solver.step();
  }
  const child = solver.activeSubSolver;
  expect(child).not.toBeNull();
  const originalBudget = Number(solver.stats.expansionIterationBudget);

  solver.MAX_ITERATIONS += 8;
  solver.step();

  expect(solver.activeSubSolver).toBe(child);
  expect(child!.solved || child!.failed).toBe(false);
  expect(solver.stats.expansionIterationBudget).toBe(originalBudget + 7);
  expect(
    Number(solver.stats.expansionIterationBudget) +
      Number(solver.stats.finalizationIterationReserve),
  ).toBe(solver.MAX_ITERATIONS);
});
