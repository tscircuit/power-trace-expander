import { expect, test } from "bun:test";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { PowerTraceExpanderSolver } from "../src";

test("final acceptance never applies an in-flight candidate", () => {
  const solver = new PowerTraceExpanderSolver(
    structuredClone(simplifiedCases.narrowChannelRetreat),
  );

  while (
    (!solver.activeSubSolver || solver.activeSubSolver.iterations === 0) &&
    !solver.solved &&
    !solver.failed
  ) {
    solver.step();
  }
  expect(solver.activeSubSolver).toBeDefined();
  expect(solver.activeSubSolver!.iterations).toBeGreaterThan(0);
  const discardedChild = solver.activeSubSolver;
  const lastCommittedTraces = structuredClone(solver.getOutput());
  solver.tryFinalAcceptance();

  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.error).toBeNull();
  expect(solver.progress).toBe(1);
  expect(solver.activeSubSolver).toBeNull();
  expect(solver.budgetLimitedExpansion).toBe(false);
  expect(solver.finalAcceptanceUsed).toBe(true);
  expect(solver.cleanupCompleted).toBe(false);
  expect(solver.clearanceRepairCompleted).toBe(false);
  expect(solver.failedSubSolvers ?? []).not.toContain(discardedChild);
  expect(solver.stats).toMatchObject({
    completionReason: "total_iteration_budget",
    budgetLimitedExpansion: false,
    finalAcceptanceUsed: true,
  });
  expect(solver.getOutput()).toEqual(lastCommittedTraces);
});

test("reserves budget for cleanup and clearance repair", () => {
  const input = structuredClone(simplifiedCases.narrowChannelRetreat);
  const originalTraceIds = input.traces!.map((trace) => trace.pcb_trace_id);
  const solver = new PowerTraceExpanderSolver(input);
  solver.MAX_ITERATIONS = 10_000;

  while (
    (!solver.activeSubSolver || solver.activeSubSolver.iterations === 0) &&
    !solver.solved &&
    !solver.failed
  ) {
    solver.step();
  }
  const discardedChild = solver.activeSubSolver;
  const lastCommittedTraces = structuredClone(solver.getOutput());
  const expansionIterationBudget = Number(
    solver.stats.expansionIterationBudget,
  );
  const finalizationIterationReserve = Number(
    solver.stats.finalizationIterationReserve,
  );
  solver.iterations = expansionIterationBudget - 1;
  solver.step();

  expect(solver.phase).toBe("cleanup");
  expect(solver.activeSubSolver).not.toBe(discardedChild);
  expect(solver.failedSubSolvers ?? []).not.toContain(discardedChild);
  expect(solver.getOutput()).toEqual(lastCommittedTraces);
  expect(solver.stats.completionReason).toBeNull();

  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.budgetLimitedExpansion).toBe(true);
  expect(solver.finalAcceptanceUsed).toBe(false);
  expect(solver.cleanupCompleted).toBe(true);
  expect(solver.clearanceRepairCompleted).toBe(true);
  expect(solver.iterations).toBeLessThan(solver.MAX_ITERATIONS);
  expect(solver.activeSubSolver).toBeNull();
  expect(solver.getOutput().map((trace) => trace.pcb_trace_id)).toEqual(
    originalTraceIds,
  );
  expect(expansionIterationBudget + finalizationIterationReserve).toBe(
    solver.MAX_ITERATIONS,
  );
  expect(solver.stats).toMatchObject({
    budgetLimitedExpansion: true,
    finalAcceptanceUsed: false,
    cleanupCompleted: true,
    clearanceRepairCompleted: true,
    completionReason: "expansion_budget",
    resultStatus: "best_effort",
  });
});

test("top-level final acceptance adopts cleanup's committed prefix", () => {
  const solver = new PowerTraceExpanderSolver(
    structuredClone(simplifiedCases.narrowChannelRetreat),
  );
  solver.MAX_ITERATIONS = 10_000;

  while (
    (!solver.activeSubSolver || solver.activeSubSolver.iterations === 0) &&
    !solver.solved &&
    !solver.failed
  ) {
    solver.step();
  }
  solver.iterations = Number(solver.stats.expansionIterationBudget) - 1;
  solver.step();
  expect(solver.phase).toBe("cleanup");
  solver.activeSubSolver!.step();
  expect(solver.activeSubSolver?.iterations).toBeGreaterThan(0);

  solver.tryFinalAcceptance();

  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.finalAcceptanceUsed).toBe(true);
  expect(solver.cleanupCompleted).toBe(false);
  expect(solver.cleanupBestEffortAccepted).toBe(true);
  expect(solver.clearanceRepairCompleted).toBe(false);
  expect(solver.clearanceRepairBestEffortAccepted).toBe(false);
  expect(solver.stats).toMatchObject({
    cleanupStatus: "budget_limited",
    clearanceRepairStatus: "not_started",
    completionReason: "total_iteration_budget",
    resultStatus: "best_effort",
  });
});

test("bounds failed-candidate history while preserving useful context", () => {
  const solver = new PowerTraceExpanderSolver(
    structuredClone(simplifiedCases.narrowChannelRetreat),
  );
  solver.MAX_ITERATIONS = 10_000;

  while (
    (solver.failedSubSolvers?.length ?? 0) < 16 &&
    !solver.solved &&
    !solver.failed
  ) {
    solver.step();
  }
  expect(solver.failedSubSolvers).toHaveLength(16);
  const firstFailures = solver.failedSubSolvers!.slice(0, 15);
  const previousLatestFailure = solver.failedSubSolvers![15];

  while (
    solver.failedSubSolvers?.[15] === previousLatestFailure &&
    !solver.solved &&
    !solver.failed
  ) {
    solver.step();
  }

  expect(solver.failedSubSolvers).toHaveLength(16);
  for (const [index, failure] of firstFailures.entries()) {
    expect(solver.failedSubSolvers![index]).toBe(failure);
  }
  expect(solver.failedSubSolvers![15]).not.toBe(previousLatestFailure);
  expect(solver.failedSubSolverCount).toBeGreaterThan(16);
  expect(solver.stats.failedSubSolverCount).toBe(solver.failedSubSolverCount);
  expect(solver.stats.retainedFailedSubSolverCount).toBe(16);
});

test("batches 64 child steps in one expander iteration", () => {
  const solver = new PowerTraceExpanderSolver(
    structuredClone(simplifiedCases.narrowChannelRetreat),
  );
  while (!solver.activeSubSolver && !solver.solved && !solver.failed) {
    solver.step();
  }
  const child = solver.activeSubSolver!;
  const parentIterations = solver.iterations;
  const committedTraces = structuredClone(solver.getOutput());

  solver.step();

  expect(child.iterations).toBe(64);
  expect(solver.iterations).toBe(parentIterations + 1);
  expect(solver.MAX_ITERATIONS).toBe(125_000);
  expect(solver.getOutput()).toEqual(committedTraces);
});

test("stops batching at the child completion boundary", () => {
  const solver = new PowerTraceExpanderSolver({
    layerCount: 2,
    minTraceWidth: 0.15,
    bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
    connections: [],
    obstacles: [],
    traces: [],
  });
  solver.step();
  const cleanup = solver.activeSubSolver!;

  solver.step();

  expect(cleanup.solved).toBe(true);
  expect(cleanup.iterations).toBeLessThan(64);
  expect(solver.phase).toBe("repair-trace-clearance");
  expect(solver.activeSubSolver?.iterations).toBe(0);
  solver.solve();
  expect(solver.solved).toBe(true);
  const completedIterations = solver.iterations;
  solver.step();
  expect(solver.iterations).toBe(completedIterations);
});

test("a failing child operation immediately stops the batch", () => {
  const solver = new PowerTraceExpanderSolver({
    layerCount: 2,
    minTraceWidth: 0.15,
    bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
    connections: [],
    obstacles: [],
    traces: [],
  });
  solver.step();
  const cleanup = solver.activeSubSolver!;
  cleanup._step = () => {
    if (cleanup.iterations === 3) throw new Error("synthetic cleanup failure");
  };

  expect(() => solver.step()).toThrow("synthetic cleanup failure");

  expect(solver.failed).toBe(true);
  expect(cleanup.iterations).toBe(3);
  solver.step();
  expect(cleanup.iterations).toBe(3);
});
