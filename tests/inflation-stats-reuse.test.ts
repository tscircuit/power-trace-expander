import { expect, test } from "bun:test";
import { simplifiedCases } from "../fixtures/simplified-cases";
import { LocalTraceInflationSolver } from "../src/LocalTraceInflationSolver";

type StatsHarness = {
  createStats(): Record<string, unknown>;
};

test("reuses inflation stats during child searches and preserves prior snapshots", (): void => {
  const problem = structuredClone(simplifiedCases.inflationPushesSignal);
  const solver = new LocalTraceInflationSolver({
    simpleRouteJson: problem,
    traces: problem.traces,
    powerTraceIndex: 0,
    nominalPowerWidth: 0.8,
    corridor: [{ start: { x: -4, y: 0 }, end: { x: 4, y: 0 }, layer: "top", width: 0.8 }],
    maxRerouteLength: 10,
  });
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
  let childCompleted = false;
  let budgetChanged = false;

  while (!solver.solved && !solver.failed) {
    const child = solver.activeSubSolver;
    const previousStats = solver.stats;
    const previousSnapshotCount = snapshotCount;
    if (child && child.iterations === 1 && !budgetChanged) {
      solver.MAX_ITERATIONS += 8;
      budgetChanged = true;
    }
    solver.step();

    expect(solver.stats).toEqual(createStats());
    if (child && !child.solved && !child.failed && solver.activeSubSolver === child) {
      expect(solver.stats).toBe(previousStats);
      expect(snapshotCount).toBe(previousSnapshotCount);
      reusedSnapshotCount++;
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
  expect(childCompleted).toBe(true);
  expect(budgetChanged).toBe(true);
  expect(reusedSnapshotCount).toBeGreaterThan(0);
  expect(solver.getOutput()?.pushedTraceIndex).toBe(1);
  for (const snapshot of snapshots) {
    expect(snapshot.stats).toEqual(snapshot.expected);
  }
});
