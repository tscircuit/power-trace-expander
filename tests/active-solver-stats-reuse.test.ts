import { expect, test } from "bun:test";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { PowerTraceExpanderSolver } from "../src/PowerTraceExpanderSolver";

type StatsHarness = {
  createStats(): Record<string, unknown>;
};

test("reuses unchanged parent stats without losing snapshots or budget changes", (): void => {
  const solver = new PowerTraceExpanderSolver(
    structuredClone(simplifiedCases.narrowChannelRetreat),
  );
  const harness = solver as unknown as StatsHarness;
  const createStats = harness.createStats.bind(solver);
  let snapshotCount = 0;
  harness.createStats = (): Record<string, unknown> => {
    snapshotCount++;
    return createStats();
  };
  const snapshots: Array<{
    stats: Record<string, unknown>;
    expected: Record<string, unknown>;
  }> = [];
  let reusedSnapshotCount = 0;
  let budgetChanged = false;
  let childCompleted = false;
  solver.MAX_ITERATIONS = 600;

  while (!solver.solved && !solver.failed) {
    const child = solver.activeSubSolver;
    const previousStats = solver.stats;
    const previousSnapshotCount = snapshotCount;
    const changeBudget = !!child && child.iterations === 1 && !budgetChanged;
    if (changeBudget) {
      solver.MAX_ITERATIONS += 8;
      budgetChanged = true;
    }
    solver.step();

    // The original implementation built this full snapshot after every step.
    expect(solver.stats).toEqual(createStats());
    if (
      child &&
      !child.solved &&
      !child.failed &&
      solver.activeSubSolver === child
    ) {
      if (changeBudget) {
        expect(solver.stats).not.toBe(previousStats);
        expect(snapshotCount).toBe(previousSnapshotCount + 1);
      } else {
        expect(solver.stats).toBe(previousStats);
        expect(snapshotCount).toBe(previousSnapshotCount);
        reusedSnapshotCount++;
      }
    }
    if (child && (child.solved || child.failed)) {
      expect(solver.stats).not.toBe(previousStats);
      childCompleted = true;
    }
    if (solver.stats !== previousStats) {
      snapshots.push({
        stats: solver.stats,
        expected: structuredClone(solver.stats),
      });
    }
  }

  expect(solver.solved).toBe(true);
  expect(budgetChanged).toBe(true);
  expect(childCompleted).toBe(true);
  expect(reusedSnapshotCount).toBeGreaterThan(0);
  for (const snapshot of snapshots) {
    expect(snapshot.stats).toEqual(snapshot.expected);
  }
});
