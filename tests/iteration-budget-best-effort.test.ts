import { expect, test } from "bun:test";
import "bun-match-svg";
import {
  getBounds,
  getSvgFromGraphicsObject,
  stackGraphicsHorizontally,
} from "graphics-debug";
import { simplifiedCases } from "../fixtures/simplified-cases";
import {
  PowerTraceCleanupSolver,
  PowerTraceExpanderSolver,
  type PowerTraceExpanderInput,
} from "../src";
import { PhysicalConnectivityInvariant } from "../src/PhysicalConnectivityInvariant";
import type { SimplifiedPcbTrace } from "../src/types";

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

test("optionally widens clear branches in place at the search limit", async () => {
  const trace = (
    name: string,
    y: number,
    nominalTraceWidth?: number,
    width = 0.15,
  ): SimplifiedPcbTrace => ({
    type: "pcb_trace",
    pcb_trace_id: name,
    connection_name: name,
    nominalTraceWidth,
    route: [
      { route_type: "wire", layer: "top", width, x: -4, y },
      { route_type: "wire", layer: "top", width, x: 4, y },
    ],
  });
  const traces = [
    trace("clear", 0, 0.8),
    trace("blocked", 2, 0.8),
    trace("no-branch-target", -2),
    trace("not-selected", -4, 0.8),
  ];
  const input: PowerTraceExpanderInput = {
    bounds: { minX: -6, minY: -6, maxX: 6, maxY: 6 },
    layerCount: 2,
    minTraceWidth: 0.15,
    obstacles: [],
    traces,
    fixedTraces: [trace("blocker", 2.3)],
    connections: traces.map(({ pcb_trace_id, route }) => ({
      name: pcb_trace_id,
      nominalTraceWidth: 0.8,
      pointsToConnect: route.flatMap((point) =>
        point.route_type === "wire"
          ? [{ x: point.x, y: point.y, layer: point.layer }]
          : [],
      ),
    })),
  };
  const solveAtBudget = (widenInPlaceAtSearchLimit?: boolean) => {
    const solver = new PowerTraceExpanderSolver(input, {
      onlyConnectionNames: ["clear", "blocked", "no-branch-target"],
      widenInPlaceAtSearchLimit,
    });
    solver.iterations = Number(solver.stats.expansionIterationBudget);
    solver.solve();
    expect(solver.stats).toMatchObject({
      budgetLimitedExpansion: true,
      cleanupCompleted: true,
      clearanceRepairCompleted: true,
    });
    return solver.getOutput();
  };

  const disabled = solveAtBudget();
  const enabled = solveAtBudget(true);
  expect(disabled).toEqual(traces);
  expect(enabled).toEqual([trace("clear", 0, 0.8, 0.8), ...traces.slice(1)]);
  expect(
    new PhysicalConnectivityInvariant(input, traces).validate(enabled).safe,
  ).toBe(true);

  const runs = [
    ["Widening off", disabled],
    ["Widening on", enabled],
  ] as const;
  const panels = runs.map(([label, output]) => {
    const clearBranch = output.find((trace) => trace.pcb_trace_id === "clear")!;
    const points = clearBranch.route.filter(
      (point) => point.route_type === "wire",
    );
    const [start, end] = points;
    return {
      coordinateSystem: "cartesian" as const,
      lines: [{ points, strokeWidth: start.width, strokeColor: "#087f5b" }],
      texts: [
        {
          x: (start.x + end.x) / 2,
          y: start.y + 1,
          text: `${label} · ${start.width.toFixed(2)} mm`,
          fontSize: 0.46,
        },
      ],
    };
  });
  const comparison = stackGraphicsHorizontally(panels);
  const { minX, maxX, maxY } = getBounds(comparison);
  comparison.texts!.push({
    x: (minX + maxX) / 2,
    y: maxY + 0.75,
    text: "Clear branch at the search limit",
    fontSize: 0.58,
  });
  await expect(
    getSvgFromGraphicsObject(comparison, {
      backgroundColor: "white",
      svgWidth: 800,
      svgHeight: 190,
    }),
  ).toMatchSvgSnapshot(import.meta.path, "widen-in-place");
});

test("budget widening checks the reversed envelopes of the branch and its peers", () => {
  const trace = (
    name: string,
    points: ReadonlyArray<readonly [x: number, y: number, width?: number]>,
  ): SimplifiedPcbTrace => ({
    type: "pcb_trace",
    pcb_trace_id: name,
    connection_name: name,
    nominalTraceWidth: 0.8,
    route: points.map(([x, y, width = 0.15]) => ({
      route_type: "wire",
      layer: "top",
      width,
      x,
      y,
    })),
  });
  const traces = [
    trace("hole-side-branch", [
      [-5, 0],
      [-4, 0],
      [-4, 3],
      [4, 3],
    ]),
    trace("peer-side-branch", [
      [-2, 5.75],
      [2, 5.75],
    ]),
  ];
  const input: PowerTraceExpanderInput = {
    bounds: { minX: -7, minY: -2, maxX: 7, maxY: 9 },
    layerCount: 2,
    minTraceWidth: 0.15,
    minTraceToHoleEdgeClearance: 0.2,
    obstacles: [
      {
        type: "rect",
        shape: "circle",
        isNonPlatedHole: true,
        center: { x: 0, y: 3.55 },
        width: 0.4,
        height: 0.4,
        layers: ["top", "bottom"],
        connectedTo: [],
      },
    ],
    traces,
    fixedTraces: [
      trace("peer", [
        [-5, 7],
        [-4, 7, 0.8],
        [-4, 5],
        [4, 5],
      ]),
    ],
    connections: [
      {
        name: "hole-side-branch",
        pointsToConnect: [
          { x: -5, y: 0, layer: "top" },
          { x: 4, y: 3, layer: "top" },
        ],
      },
      {
        name: "peer-side-branch",
        pointsToConnect: [
          { x: -2, y: 5.75, layer: "top" },
          { x: 2, y: 5.75, layer: "top" },
        ],
      },
    ],
  };
  const solver = new PowerTraceExpanderSolver(input, {
    widenInPlaceAtSearchLimit: true,
  });
  solver.iterations = Number(solver.stats.expansionIterationBudget);
  solver.solve();

  expect(solver.stats).toMatchObject({
    budgetLimitedExpansion: true,
    expandedSegmentCount: 0,
    clearanceRepairCompleted: true,
  });
  expect(solver.getOutput()).toEqual(traces);
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
  const childIterations = child.iterations;
  const parentIterations = solver.iterations;
  const committedTraces = structuredClone(solver.getOutput());

  solver.step();

  expect(child.iterations - childIterations).toBe(64);
  expect(solver.iterations).toBe(parentIterations + 1);
  expect(solver.MAX_ITERATIONS).toBe(125_000);
  expect(solver.getOutput()).toEqual(committedTraces);
});

test("stops a completed expander within its batch", () => {
  const solver = new PowerTraceExpanderSolver({
    layerCount: 2,
    minTraceWidth: 0.15,
    bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
    connections: [],
    obstacles: [],
    traces: [],
  });

  solver.step();

  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.iterations).toBe(1);
  expect(solver.cleanupCompleted).toBe(true);
  expect(solver.clearanceRepairCompleted).toBe(true);
  solver.step();
  expect(solver.iterations).toBe(1);
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
  const cleanup = new PowerTraceCleanupSolver({
    simpleRouteJson: solver.inputProblem,
    traces: [],
    traceIndices: [],
  });
  solver.phase = "cleanup";
  solver.activeSubSolver = cleanup;
  cleanup._step = () => {
    if (cleanup.iterations === 3) throw new Error("synthetic cleanup failure");
  };

  expect(() => solver.step()).toThrow("synthetic cleanup failure");

  expect(solver.failed).toBe(true);
  expect(cleanup.iterations).toBe(3);
  solver.step();
  expect(cleanup.iterations).toBe(3);
});

test("16 batches retain the 1024-operation straight-trace width result", () => {
  const solver = new PowerTraceExpanderSolver(
    structuredClone(simplifiedCases.straightClear),
  );
  solver.MAX_ITERATIONS = 16;

  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.budgetLimitedExpansion).toBe(false);
  const wires = solver
    .getOutput()[0]!
    .route.filter((point) => point.route_type === "wire");
  expect(wires).toHaveLength(5);
  expect(wires.every((point) => point.width === 0.8)).toBe(true);
});

test("16 batches retain the 1024-operation cleanup budget", () => {
  const solver = new PowerTraceExpanderSolver(
    structuredClone(simplifiedCases.narrowChannelRetreat),
  );
  solver.MAX_ITERATIONS = 16;

  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.budgetLimitedExpansion).toBe(true);
  expect(solver.cleanupIterationBudget).toBe(95);
  expect(solver.cleanupCompleted).toBe(true);
  expect(solver.iterations).toBeLessThanOrEqual(solver.MAX_ITERATIONS);
});

test("3 batches retain the 192-operation finalization reserve", () => {
  const solver = new PowerTraceExpanderSolver(
    structuredClone(simplifiedCases.narrowChannelRetreat),
  );
  solver.MAX_ITERATIONS = 3;

  solver.solve();

  expect(solver.solved).toBe(true);
  expect(solver.budgetLimitedExpansion).toBe(true);
  expect(solver.cleanupIterationBudget).toBe(17);
  expect(solver.iterations).toBeLessThanOrEqual(solver.MAX_ITERATIONS);
});
